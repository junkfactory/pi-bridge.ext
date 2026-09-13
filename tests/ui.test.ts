/**
 * Tests for the focused pi-side approval prompt (`promptSelection`).
 *
 * The prompt is implemented via `ctx.ui.custom` WITHOUT overlay so pi
 * replaces its input box with our component. We mock the factory to
 * capture the component and exercise its key handling in isolation.
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { type PromptDecision, promptSelection } from "../src/ui.js";

function makeTheme() {
	initTheme("dark");
	const sym = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const t = (globalThis as Record<symbol, unknown>)[sym];
	if (!t) throw new Error("Theme not initialized");
	return t;
}

interface CapturedFactory {
	tui: unknown;
	theme: ReturnType<typeof makeTheme>;
	keybindings: unknown;
	done: ReturnType<typeof vi.fn>;
	component: {
		handleInput?: (data: string) => void;
		render(width: number): string[];
		invalidate(): void;
	};
}

/**
 * Build a mock ctx whose `ui.custom` captures the factory call and
 * returns a promise that resolves when the component's `done()` is
 * called. Tests can settle the promise directly via `resolveCustom`
 * (useful when a test doesn't trigger any keypress) — it must be
 * accessed through a getter because plain destructuring snapshots the
 * value before the inner Promise executor has assigned it.
 */
function makeCtxWithCapturedCustom(): {
	ctx: Parameters<typeof promptSelection>[0];
	resolveCustomRef: { current: (decision: PromptDecision | undefined) => void };
	captured: CapturedFactory;
} {
	const captured = {} as CapturedFactory;
	const resolveCustomRef: {
		current: (decision: PromptDecision | undefined) => void;
	} = { current: () => {} };
	const custom = vi.fn(
		(
			factory: (
				tui: unknown,
				theme: ReturnType<typeof makeTheme>,
				keybindings: unknown,
				done: (decision: PromptDecision) => void,
			) => unknown,
		) => {
			const theme = makeTheme();
			captured.tui = {};
			captured.theme = theme;
			captured.keybindings = {};
			// The mock done() records the call AND resolves the outer
			// promise — this mirrors what pi's real `custom` does
			// internally. The test asserts on the call args via the
			// captured.done mock.
			const done = vi.fn((decision: PromptDecision) => {
				resolveCustomRef.current(decision);
			});
			captured.done = done;
			captured.component = factory(
				captured.tui,
				theme,
				captured.keybindings,
				done,
			) as CapturedFactory["component"];
			return new Promise<PromptDecision | undefined>((resolve) => {
				resolveCustomRef.current = (decision) => resolve(decision);
			});
		},
	);
	const ctx = { ui: { custom } } as unknown as Parameters<
		typeof promptSelection
	>[0];
	return { ctx, resolveCustomRef, captured };
}

describe("promptSelection — component lifecycle", () => {
	it("calls ctx.ui.custom (no overlay flag) with a component factory", async () => {
		const { ctx, resolveCustomRef, captured } = makeCtxWithCapturedCustom();
		const promise = promptSelection(ctx);
		// Settle so the test exits cleanly.
		resolveCustomRef.current("yes");
		await promise;
		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		const [factory, options] = (ctx.ui.custom as ReturnType<typeof vi.fn>).mock
			.calls[0] as [unknown, unknown];
		expect(typeof factory).toBe("function");
		// Either no options or options without `overlay: true`.
		if (options !== undefined) {
			expect((options as { overlay?: boolean }).overlay).not.toBe(true);
		}
		expect(captured.component).toBeDefined();
		expect(typeof captured.component.render).toBe("function");
		expect(typeof captured.component.invalidate).toBe("function");
		expect(typeof captured.component.handleInput).toBe("function");
	});

	it("renders a bordered y/a/n prompt line", async () => {
		const { ctx, resolveCustomRef, captured } = makeCtxWithCapturedCustom();
		const promise = promptSelection(ctx);
		const lines = captured.component.render(80);
		// Three lines: top border, prompt line, bottom border.
		expect(lines).toHaveLength(3);
		const promptLine = lines[1];
		// The line must mention every decision key for the user.
		expect(promptLine).toContain("y");
		expect(promptLine).toContain("a");
		expect(promptLine).toContain("n");
		// Esc handling is part of the prompt semantics; mention it in the
		// rendered hint so the user knows how to cancel.
		expect(promptLine.toLowerCase()).toContain("esc");
		resolveCustomRef.current("yes");
		await promise;
	});
});

describe("promptSelection — key handling", () => {
	for (const [key, expected] of [
		["y", "yes"],
		["a", "all"],
		["n", "no"],
	] as const) {
		it(`maps '${key}' to done('${expected}')`, async () => {
			const { ctx, captured } = makeCtxWithCapturedCustom();
			const promise = promptSelection(ctx);
			captured.component.handleInput?.(key);
			expect(captured.done).toHaveBeenCalledWith(expected);
			expect(await promise).toBe(expected);
		});
	}

	for (const escKey of ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1;27~"]) {
		it(`maps escape (${JSON.stringify(escKey)}) to done('cancelled')`, async () => {
			const { ctx, captured } = makeCtxWithCapturedCustom();
			const promise = promptSelection(ctx);
			captured.component.handleInput?.(escKey);
			expect(captured.done).toHaveBeenCalledWith("cancelled");
			expect(await promise).toBe("cancelled");
		});
	}

	it("ignores unrelated keys (does not call done)", async () => {
		const { ctx, resolveCustomRef, captured } = makeCtxWithCapturedCustom();
		const promise = promptSelection(ctx);
		for (const key of ["Y", "x", "\r", "\t", "1", " "]) {
			captured.component.handleInput?.(key);
		}
		expect(captured.done).not.toHaveBeenCalled();
		// Settle so the test exits.
		resolveCustomRef.current("no");
		await promise;
	});
});

describe("promptSelection — non-TUI fallback", () => {
	it("resolves 'cancelled' when ctx.ui.custom returns undefined (RPC mode)", async () => {
		const ctx = {
			ui: {
				custom: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as Parameters<typeof promptSelection>[0];
		expect(await promptSelection(ctx)).toBe("cancelled");
	});
});
