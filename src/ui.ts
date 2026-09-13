/**
 * TUI helpers for the edit-approval gate.
 *
 * Single surface: `promptSelection(ctx)` — a non-overlay `ctx.ui.custom`
 * component that replaces pi's input box with a focused bordered
 * `approve: y / a(ll this file) / n` prompt while a Neovim-originated edit
 * is awaiting approval. Keys:
 *   y      → "yes"
 *   a      → "all"
 *   n      → "no"
 *   escape → "cancelled"
 *
 * The diff itself is rendered by pi's built-in edit/write preview in the
 * transcript; we don't duplicate it here. Restoration of the editor is
 * handled by pi when `done()` is called.
 *
 * RPC / headless: `ctx.ui.custom` returns undefined in non-TUI modes. We
 * resolve "cancelled" in that case so the gate still blocks the edit
 * (preserves the prior fail-safe).
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export type PromptDecision = "yes" | "all" | "no" | "cancelled";

const PROMPT_LINE = "approve: y / a(ll this file) / n  (Esc: cancel)";

/**
 * Minimal Component that renders a single bordered line and maps a small
 * set of keys to decisions. Local to this module — pi-tui is a transitive
 * dependency of pi-coding-agent and isn't resolvable from this extension's
 * root node_modules, so we keep the type as a structural shape that
 * matches pi-tui's Component without importing it.
 */
interface ComponentLike {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	dispose?(): void;
}

class ApprovalPromptComponent implements ComponentLike {
	handleInput?: (data: string) => void;

	constructor(
		private readonly tui: unknown,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const inner = PROMPT_LINE;
		const styled = this.theme.fg("accent", inner);
		// pi-tui's BorderedLoader is unavailable here — render a hand-rolled
		// single-line box. Width 0 / negative means "use as much as you have";
		// we clamp the inner line so we don't draw past the right edge.
		const pad = Math.max(0, width - inner.length - 4);
		const line = `│ ${styled}${" ".repeat(pad)} │`;
		const bar = `─${"─".repeat(Math.max(0, width - 2))}─`;
		// The tui reference is kept around for parity with pi-tui components
		// that need it for input-mode registration; we don't use it directly.
		void this.tui;
		return [bar, line, bar];
	}

	invalidate(): void {
		// No cached state.
	}
}

/**
 * Match the Escape key across terminal keyboard protocols.
 *
 * pi's TUI requests Kitty keyboard flags, so on negotiating terminals
 * (kitty, ghostty) Escape arrives as CSI-u — not the raw byte. Mirrors
 * pi-tui's `Key.escape` matching: raw `\x1b`, kitty CSI-u (`\x1b[27u`,
 * `\x1b[27;1u`), and xterm modifyOtherKeys (`\x1b[27;1;27~`).
 */
function isEscapeKey(data: string): boolean {
	if (data === "\x1b") return true;
	// Biome forbids control characters in regex literals; build the escape
	// byte dynamically.
	const ESC = String.fromCharCode(27);
	if (new RegExp(`^${ESC}\\[27(?:;1)?u$`).test(data)) return true;
	if (new RegExp(`^${ESC}\\[27;1;27~$`).test(data)) return true;
	return false;
}

/**
 * Show the approval prompt and wait for the user's answer.
 *
 * Replaces pi's input box with our focused component (no overlay), so the
 * editor is hidden for the duration of the prompt. pi restores the editor
 * when `done()` is called.
 */
export async function promptSelection(
	ctx: ExtensionContext,
): Promise<PromptDecision> {
	const result = await ctx.ui.custom<PromptDecision>(
		(tui, theme, _keybindings, done) => {
			const component = new ApprovalPromptComponent(tui, theme);
			component.handleInput = (data: string) => {
				if (data === "y") done("yes");
				else if (data === "a") done("all");
				else if (data === "n") done("no");
				else if (isEscapeKey(data)) done("cancelled");
			};
			return component;
		},
	);
	// Non-TUI modes (RPC / print / json) return undefined — preserve the
	// fail-safe "cancelled" semantics from the prior overlay path.
	if (result === undefined) return "cancelled";
	return result;
}
