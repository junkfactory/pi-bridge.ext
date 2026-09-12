import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	APPROVAL_HINT_BELOW_EDITOR,
	classifyDiffLine,
	colorizeDiffLine,
	isEscapeKey,
	OVERLAY_HEADER,
	renderWidgetText,
} from "../src/ui.js";

/** Initialize pi's theme system and return the global theme instance
 *  via globalThis (the only way to get the singleton from outside). */
function makeTheme(): Theme {
	initTheme("dark");
	const sym = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const t = (globalThis as Record<symbol, unknown>)[sym] as Theme;
	if (!t) throw new Error("Theme not initialized");
	return t;
}

describe("classifyDiffLine", () => {
	it("classifies additions", () => {
		expect(classifyDiffLine("+new line")).toBe("added");
		expect(classifyDiffLine("+")).toBe("added");
	});

	it("classifies removals", () => {
		expect(classifyDiffLine("-old line")).toBe("removed");
		expect(classifyDiffLine("-")).toBe("removed");
	});

	it("classifies context lines", () => {
		expect(classifyDiffLine(" unchanged")).toBe("context");
		expect(classifyDiffLine("unchanged")).toBe("context");
	});

	it("classifies file headers as meta", () => {
		expect(classifyDiffLine("--- a/file.ts")).toBe("meta");
		expect(classifyDiffLine("+++ b/file.ts")).toBe("meta");
	});

	it("classifies hunk headers as meta", () => {
		expect(classifyDiffLine("@@ -1,3 +1,3 @@")).toBe("meta");
	});
});

describe("colorizeDiffLine", () => {
	const theme = makeTheme();

	it("uses toolDiffAdded for additions", () => {
		const out = colorizeDiffLine("+new", theme);
		expect(theme.fg("toolDiffAdded", "+new")).toBe(out);
	});

	it("uses toolDiffRemoved for removals", () => {
		const out = colorizeDiffLine("-old", theme);
		expect(theme.fg("toolDiffRemoved", "-old")).toBe(out);
	});

	it("uses toolDiffContext for context", () => {
		const out = colorizeDiffLine(" same", theme);
		expect(theme.fg("toolDiffContext", " same")).toBe(out);
	});

	it("uses dim for meta lines", () => {
		const out = colorizeDiffLine("--- a/file", theme);
		expect(theme.fg("dim", "--- a/file")).toBe(out);
	});
});

describe("renderWidgetText", () => {
	it("includes the overlay header followed by colorized diff lines", () => {
		const theme = makeTheme();
		const diff = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new";
		const text = renderWidgetText(diff, theme);
		// Header is always present somewhere.
		expect(text).toContain(OVERLAY_HEADER);
		// Then each diff line.
		expect(text).toContain("-old");
		expect(text).toContain("+new");
	});

	it("produces a string that round-trips through split('\\n')", () => {
		const theme = makeTheme();
		// Diff has 3 lines (no trailing newline); header is the 4th.
		const text = renderWidgetText("+a\n-b\n c", theme);
		const lines = text.split("\n");
		expect(lines.length).toBe(4);
	});
});

// ---------------------------------------------------------------------------
// showApprovalHint / clearDiffWidget integration with ctx.ui.setWidget
// ---------------------------------------------------------------------------

describe("showApprovalHint / clearDiffWidget", () => {
	function makeCtx() {
		const setWidget = vi.fn();
		const ctx = { ui: { setWidget } } as unknown as Parameters<
			typeof import("../src/ui.js").showApprovalHint
		>[0];
		return { ctx, setWidget };
	}

	it("calls setWidget with the hint lines below the editor", async () => {
		const { showApprovalHint } = await import("../src/ui.js");
		const { ctx, setWidget } = makeCtx();
		showApprovalHint(ctx);
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(setWidget).toHaveBeenCalledWith(
			"pi-bridge-approval",
			[APPROVAL_HINT_BELOW_EDITOR],
			{ placement: "belowEditor" },
		);
	});

	it("clearDiffWidget calls setWidget with undefined to remove the widget", async () => {
		const { clearDiffWidget } = await import("../src/ui.js");
		const { ctx, setWidget } = makeCtx();
		clearDiffWidget(ctx);
		expect(setWidget).toHaveBeenCalledWith("pi-bridge-approval", undefined);
	});
});

describe("isEscapeKey", () => {
	it("matches the raw escape byte", () => {
		expect(isEscapeKey("\x1b")).toBe(true);
	});
	it("matches the kitty CSI-u escape", () => {
		expect(isEscapeKey("\x1b[27u")).toBe(true);
		expect(isEscapeKey("\x1b[27;1u")).toBe(true);
	});
	it("matches the xterm modifyOtherKeys escape", () => {
		expect(isEscapeKey("\x1b[27;1;27~")).toBe(true);
	});
	it("does not match letters or unrelated sequences", () => {
		expect(isEscapeKey("y")).toBe(false);
		expect(isEscapeKey("n")).toBe(false);
		expect(isEscapeKey("\x1b[1;2A")).toBe(false);
		expect(isEscapeKey("\x1b[A")).toBe(false);
	});
});
