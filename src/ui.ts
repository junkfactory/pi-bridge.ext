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
 * handled by pi when pi's `done()` is called.
 *
 * Remote dismissal: the gate can settle before the user presses a key
 * (nvim answered first, Ctrl+C abort, session reset). `promptSelection`
 * therefore returns a handle whose `dismiss()` tears the component down
 * (resolves as "cancelled") so pi's editor is restored immediately
 * instead of waiting for a keypress that would be a first-wins no-op
 * anyway.
 *
 * RPC / headless: `ctx.ui.custom` returns undefined in non-TUI modes. We
 * resolve "cancelled" in that case so the gate still blocks the edit
 * (preserves the prior fail-safe).
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

export type PromptDecision = "yes" | "all" | "no" | "cancelled";

/**
 * Handle for the in-flight pi-side prompt. `decision` resolves with the
 * user's keypress (or "cancelled" when dismissed programmatically or in
 * non-TUI modes); `dismiss()` closes the prompt remotely.
 */
export interface PromptHandle {
	decision: Promise<PromptDecision>;
	dismiss: () => void;
}

/**
 * Result of a numbered-options prompt. On selection the user-chosen
 * `options[n]` is returned wrapped in `{ label }`; on dismissal (Esc,
 * `dismiss()`, or non-TUI mode) the string sentinel `"cancelled"` is
 * returned. The discriminant is the leading string vs object shape.
 */
export type OptionsDecision = { label: string } | "cancelled";

/**
 * Handle for an in-flight numbered-options prompt. Same dismissable
 * shape as `PromptHandle`, but resolves with `OptionsDecision`.
 */
export interface PromptOptionsHandle {
	decision: Promise<OptionsDecision>;
	dismiss: () => void;
}

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
 *
 * Exported so the UI mirror (src/prompt_mirror.ts) can reuse it when forwarding
 * Escape bytes from Neovim's custom-mirror float.
 */
export function isEscapeKey(data: string): boolean {
	if (data === "\x1b") return true;
	// Biome forbids control characters in regex literals; build the escape
	// byte dynamically.
	const ESC = String.fromCharCode(27);
	if (new RegExp(`^${ESC}\\[27(?:;1)?u$`).test(data)) return true;
	if (new RegExp(`^${ESC}\\[27;1;27~$`).test(data)) return true;
	return false;
}

/**
 * Set on the ui object while the edit-approval gate's own prompt is
 * opening, so the prompt mirror's `ctx.ui.custom` wrapper passes the
 * call through untouched — the gate's y/a/n prompt must never be
 * mirrored into Neovim (it has its own approval_request surface there).
 */
export const GATE_PROMPT_KEY = "__piBridgeGatePrompt";

/**
 * Shared first-wins / remote-dismissal machinery for the two pi-side
 * prompts (`promptSelection`, `promptOptions`). Owns: the settle-decision
 * promise + `once()` guard, the wrapped-done (pi's `done` isn't documented
 * as idempotent), the non-TUI fail-safe, and the `dismiss()` teardown.
 * Callers supply the component factory and T's "cancelled" sentinel.
 *
 * Returns a handle whose `decision` resolves with the user's keypress
 * (or the cancelled sentinel when dismissed programmatically or in
 * non-TUI modes); `dismiss()` closes the prompt remotely.
 */
function promptWithHandle<T>(
	ctx: ExtensionContext,
	cancelled: T,
	build: (tui: unknown, theme: Theme, done: (d: T) => void) => ComponentLike,
): { decision: Promise<T>; dismiss: () => void } {
	let settleDecision!: (d: T) => void;
	const decision = new Promise<T>((resolve) => {
		settleDecision = resolve;
	});
	let settled = false;
	const once = (d: T) => {
		if (settled) return;
		settled = true;
		settleDecision(d);
	};

	// pi's `done` callback, captured so dismiss() can tear the component
	// down when the user never presses a key. `uiSettled` guards against
	// calling it twice (keypress race) — pi's done is not documented as
	// idempotent.
	let uiDone: ((d: T) => void) | undefined;
	let uiSettled = false;

	// Flag the gate's own call so the prompt mirror's ctx.ui.custom
	// wrapper passes it through untouched (no nvim notice for the
	// y/a/n approval prompt).
	const uiHost = ctx.ui as unknown as Record<string, unknown>;
	uiHost[GATE_PROMPT_KEY] = true;
	let uiPromise: Promise<T | undefined>;
	try {
		uiPromise = ctx.ui.custom<T>((tui, theme, _keybindings, rawDone) => {
			uiDone = rawDone;
			const done = (d: T) => {
				if (uiSettled) return;
				uiSettled = true;
				rawDone(d);
			};
			return build(tui, theme, done);
		});
	} finally {
		uiHost[GATE_PROMPT_KEY] = false;
	}
	// Keypress path: forward pi's resolution (undefined in non-TUI modes →
	// fail-safe "cancelled").
	void uiPromise.then((r) => once(r ?? cancelled));

	return {
		decision,
		dismiss: () => {
			if (uiDone && !uiSettled) {
				// Component exists and no keypress yet — tear it down through
				// pi's done so the editor is restored. The decision flows back
				// through uiPromise, so a keypress racing this microtask still
				// wins (once() keeps the first answer).
				uiSettled = true;
				uiDone(cancelled);
				return;
			}
			if (!uiDone) {
				// Non-TUI mode or the factory hasn't run yet — no component to
				// tear down; settle the decision directly.
				once(cancelled);
			}
		},
	};
}

/**
 * Show the approval prompt and return a handle for it.
 *
 * Replaces pi's input box with our focused component (no overlay), so the
 * editor is hidden for the duration of the prompt. pi restores the editor
 * when pi's `done()` is called — either by a keypress or by `dismiss()`.
 */
export function promptSelection(ctx: ExtensionContext): PromptHandle {
	return promptWithHandle<PromptDecision>(
		ctx,
		"cancelled",
		(tui, theme, done) => {
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
}

/**
 * Maximum number of options that can be selected via a single digit key
 * (`1`–`9`). Mirrors the common selector UX; longer option lists still
 * render but only the first nine are key-mappable.
 */
const MAX_NUMBERED_OPTIONS = 9;

/**
 * Minimal Component that renders a bordered title line plus a numbered
 * list of options and maps digit keys `1`–`9` to the corresponding
 * option's label. Escape cancels (handled by the factory's `done`
 * wrapper, which calls `isEscapeKey`).
 */
class OptionsPromptComponent implements ComponentLike {
	handleInput?: (data: string) => void;

	constructor(
		private readonly tui: unknown,
		private readonly theme: Theme,
		private readonly title: string,
		private readonly options: readonly string[],
	) {}

	render(width: number): string[] {
		const lines: string[] = [];
		const bar = `─${"─".repeat(Math.max(0, width - 2))}─`;
		lines.push(bar);
		// Title row (clamped to keep the border aligned).
		const titleMax = Math.max(0, width - 4);
		const titleText = this.title.slice(0, titleMax);
		const titlePad = Math.max(0, width - titleText.length - 4);
		lines.push(
			`│ ${this.theme.fg("accent", titleText)}${" ".repeat(titlePad)} │`,
		);
		// Numbered options — first MAX_NUMBERED_OPTIONS get the digit hint;
		// any remainder is rendered un-numbered (still visible, just not
		// key-mappable).
		this.options.forEach((opt, idx) => {
			const n = idx + 1;
			const prefix = n <= MAX_NUMBERED_OPTIONS ? `${n}. ` : "   ";
			const content = `${prefix}${opt}`;
			const contentMax = Math.max(0, width - 4);
			const truncated = content.slice(0, contentMax);
			const pad = Math.max(0, width - truncated.length - 4);
			lines.push(`│ ${truncated}${" ".repeat(pad)} │`);
		});
		lines.push(bar);
		// The tui reference is kept for parity with pi-tui components that
		// need it for input-mode registration; we don't use it directly.
		void this.tui;
		return lines;
	}

	invalidate(): void {
		// No cached state.
	}
}

/**
 * Show a dismissable numbered-options prompt and return a handle for it.
 *
 * Generic pi-side surface for select/confirm-style mirrors: renders a
 * bordered `title` plus numbered options, maps keys `1`–`9` to
 * `options[n-1]`, and Esc to `"cancelled"`. Same first-wins / remote-
 * dismissal semantics as `promptSelection`.
 *
 * Non-TUI mode (`ctx.ui.custom` returns undefined) resolves
 * `"cancelled"` — same fail-safe posture as the edit-approval gate.
 */
export function promptOptions(
	ctx: ExtensionContext,
	title: string,
	options: readonly string[],
): PromptOptionsHandle {
	return promptWithHandle<OptionsDecision>(
		ctx,
		"cancelled",
		(tui, theme, done) => {
			const component = new OptionsPromptComponent(tui, theme, title, options);
			component.handleInput = (data: string) => {
				if (isEscapeKey(data)) {
					done("cancelled");
					return;
				}
				// Digit keys 1..9 select options[n-1]. Anything else is a
				// no-op (the user might be mid-typing a different intent).
				if (data.length === 1 && data >= "1" && data <= "9") {
					const idx = Number.parseInt(data, 10) - 1;
					if (idx >= 0 && idx < options.length) {
						done({ label: options[idx] ?? "" });
					}
				}
			};
			return component;
		},
	);
}
