/**
 * TUI helpers for the edit-approval gate.
 *
 * Two surfaces:
 *   - `showApprovalHint` / `clearDiffWidget` — a one-line hint widget
 *     below the editor that the user sees while a Neovim prompt is open
 *     (the diff itself is rendered by pi's built-in edit/write tool
 *     preview in the transcript; we don't duplicate it).
 *   - `diffOverlay` — a modal `ctx.ui.custom` component with y/a/n/esc
 *     used when Neovim hasn't answered in time. The overlay still shows
 *     the diff because pi is the decision surface there.
 *
 * Both surfaces colorize unified-diff lines using the theme's
 * `toolDiffAdded` / `toolDiffRemoved` / `toolDiffContext` tokens. The line
 * classifier is exposed as a pure helper so it's unit-testable.
 *
 * Avoids importing from `@earendil-works/pi-tui` (which is not hoisted to
 * our root node_modules) by using the string-array overload of setWidget
 * for the hint widget and a minimal inline Component for the modal
 * overlay. Both are pure ANSI text under the hood.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ApprovalDecision } from "./protocol.js";

// Minimal local Component / TUI interfaces. We don't import the real types
// from `@earendil-works/pi-tui` because that package is a transitive
// dependency of pi-coding-agent and isn't resolvable from this extension's
// root node_modules.
interface ComponentLike {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	dispose?(): void;
}
// `TUI` is only used as a parameter type for the setWidget factory; we
// accept any object here. The runtime pi-coding-agent passes a real TUI
// which structurally satisfies this.
type Component = ComponentLike;
type TUI = object;

/** Widget key used by `setWidget`. */
export const APPROVAL_WIDGET_KEY = "pi-bridge-approval";

export type DiffLineKind = "added" | "removed" | "context" | "meta";

/**
 * Classify a single line of unified diff output.
 *
 * - "+..." (not "+++")  → added
 * - "-..." (not "---")  → removed
 * - "..." (or " ")      → context
 * - anything else        → meta (file headers, hunk markers, truncation
 *                          notes). Rendered in muted/dim styling.
 */
export function classifyDiffLine(line: string): DiffLineKind {
	// Hunk headers like "@@ -1 +1 @@" — neither add nor remove; treat as meta.
	if (line.startsWith("@@")) return "meta";
	// "+++ path" / "--- path" headers — meta.
	if (line.startsWith("+++") || line.startsWith("---")) return "meta";
	if (line.startsWith("+")) return "added";
	if (line.startsWith("-")) return "removed";
	return "context";
}

/**
 * Colorize a single diff line according to the theme. Pure function — easy
 * to unit-test without a TUI.
 */
export function colorizeDiffLine(line: string, theme: Theme): string {
	const kind = classifyDiffLine(line);
	switch (kind) {
		case "added":
			return theme.fg("toolDiffAdded", line);
		case "removed":
			return theme.fg("toolDiffRemoved", line);
		case "meta":
			// File headers / hunk markers — no diff color; use dim.
			return theme.fg("dim", line);
		default:
			return theme.fg("toolDiffContext", line);
	}
}

/** Header line shown above the diff overlay (pi-TUI fallback). */
export const OVERLAY_HEADER = "approve: y / a(ll this file) / n";

/** One-line hint shown below the editor while a Neovim prompt is open. */
export const APPROVAL_HINT_BELOW_EDITOR =
	"approve: y / a(ll this file) / n — here or in Neovim";

/**
 * Match the Escape key across terminal keyboard protocols.
 *
 * pi's TUI requests Kitty keyboard flags, so on negotiating terminals
 * (kitty, ghostty) Escape arrives as CSI-u — not the raw byte. Mirrors
 * pi-tui's `Key.escape` matching: raw `\x1b`, kitty CSI-u (`\x1b[27u`,
 * `\x1b[27;1u`), and xterm modifyOtherKeys (`\x1b[27;1;27~`).
 */
export function isEscapeKey(data: string): boolean {
	if (data === "\x1b") return true;
	// Biome forbids control characters in regex literals; build the escape
	// byte dynamically (same trick as stripAnsi below).
	const ESC = String.fromCharCode(27);
	if (new RegExp(`^${ESC}\\[27(?:;1)?u$`).test(data)) return true;
	if (new RegExp(`^${ESC}\\[27;1;27~$`).test(data)) return true;
	return false;
}

/**
 * Build the rendered text for the diff overlay (header + colorized diff).
 * Exposed for unit testing — does not touch pi APIs.
 */
export function renderWidgetText(diff: string, theme: Theme): string {
	const header = theme.bold(theme.fg("accent", OVERLAY_HEADER));
	const lines = diff.split("\n").map((l) => colorizeDiffLine(l, theme));
	return [header, ...lines].join("\n");
}

/** Show a one-line approval hint below the editor. Cleared with clearDiffWidget. */
export function showApprovalHint(ctx: ExtensionContext): void {
	(
		ctx.ui.setWidget as (
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		) => void
	)(APPROVAL_WIDGET_KEY, [APPROVAL_HINT_BELOW_EDITOR], {
		placement: "belowEditor",
	});
}

/** Remove the diff widget. */
export function clearDiffWidget(ctx: ExtensionContext): void {
	(
		ctx.ui.setWidget as (
			key: string,
			content:
				| ((tui: TUI, theme: Theme) => Component & { dispose?: () => void })
				| undefined,
			options?: unknown,
		) => void
	)(APPROVAL_WIDGET_KEY, undefined);
}

/**
 * Minimal Component that renders pre-styled ANSI text and handles a small
 * set of keys. Used by `diffOverlay` so we don't import pi-tui (which is
 * a transitive dep of pi-coding-agent and not hoisted to our root
 * node_modules).
 */
class StaticTextComponent implements Component {
	private text: string;
	handleInput?: (data: string) => void;

	constructor(text: string) {
		this.text = text;
	}

	render(width: number): string[] {
		// Word-wrap using the parent TUI's width. Cheap implementation:
		// split on newlines and hard-wrap each line at `width`. The TUI
		// itself word-wraps, but we pre-wrap so the colors stay attached.
		const out: string[] = [];
		for (const line of this.text.split("\n")) {
			if (line.length === 0) {
				out.push("");
				continue;
			}
			// No wrap: most terminal diffs fit on a single line per source
			// line. Width is used as a soft cap to avoid log explosion if
			// the user has a very narrow terminal — truncate at width.
			if (width > 0 && stripAnsi(line).length > width) {
				out.push(truncateAnsi(line, width));
			} else {
				out.push(line);
			}
		}
		return out;
	}

	invalidate(): void {
		// No cached state.
	}
}

/**
 * Strip ANSI escapes for width measurement. Lightweight implementation —
 * handles the SGR sequences emitted by pi's theme helpers.
 */
function stripAnsi(s: string): string {
	// SGR escape: ESC [ params... m. We avoid \x1b in a regex (biome's
	// no-control-chars rule) by constructing the pattern dynamically.
	const ESC = String.fromCharCode(27);
	return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

/** Truncate `s` to at most `width` printable columns, keeping it ANSI-safe. */
function truncateAnsi(s: string, width: number): string {
	let out = "";
	let visible = 0;
	let inEscape = false;
	for (const ch of s) {
		if (ch === "\x1b") {
			inEscape = true;
			out += ch;
			continue;
		}
		if (inEscape) {
			out += ch;
			if (ch === "m") inEscape = false;
			continue;
		}
		if (visible >= width) break;
		out += ch;
		visible++;
	}
	return out;
}

/**
 * Run an interactive diff overlay in the TUI as a fallback when Neovim
 * can't answer the approval request. Keys: `y` (yes), `a` (all), `n` / esc
 * (no).
 *
 * Resolves with the user's decision, or `undefined` when the overlay cannot
 * run (RPC mode returns nothing for `ctx.ui.custom`) — callers must treat
 * `undefined` as "cancelled", never as an approval.
 */
export async function diffOverlay(
	ctx: ExtensionContext,
	diff: string,
): Promise<ApprovalDecision | undefined> {
	const result = await ctx.ui.custom<ApprovalDecision>(
		(_tui: TUI, theme: Theme, _keybindings, done) => {
			const component = new StaticTextComponent(renderWidgetText(diff, theme));
			component.handleInput = (data: string) => {
				if (data === "y") done("yes");
				else if (data === "a") done("all");
				else if (data === "n" || isEscapeKey(data)) done("no");
			};
			return component as Component & { dispose?(): void };
		},
		{ overlay: true },
	);
	clearDiffWidget(ctx);
	return result;
}
