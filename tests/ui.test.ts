/**
 * Tests for the focused pi-side approval prompt (`promptSelection`).
 *
 * The prompt is implemented via `ctx.ui.custom` WITHOUT overlay so pi
 * replaces its input box with our component. We mock the factory to
 * capture the component and exercise its key handling in isolation.
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	type OptionsDecision,
	type PromptDecision,
	promptOptions,
	promptSelection,
} from "../src/ui.js";

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
		const handle = promptSelection(ctx);
		// Settle so the test exits cleanly.
		resolveCustomRef.current("yes");
		await handle.decision;
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
		const handle = promptSelection(ctx);
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
		await handle.decision;
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
			const handle = promptSelection(ctx);
			captured.component.handleInput?.(key);
			expect(captured.done).toHaveBeenCalledWith(expected);
			expect(await handle.decision).toBe(expected);
		});
	}

	for (const escKey of ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1;27~"]) {
		it(`maps escape (${JSON.stringify(escKey)}) to done('cancelled')`, async () => {
			const { ctx, captured } = makeCtxWithCapturedCustom();
			const handle = promptSelection(ctx);
			captured.component.handleInput?.(escKey);
			expect(captured.done).toHaveBeenCalledWith("cancelled");
			expect(await handle.decision).toBe("cancelled");
		});
	}

	it("ignores unrelated keys (does not call done)", async () => {
		const { ctx, resolveCustomRef, captured } = makeCtxWithCapturedCustom();
		const handle = promptSelection(ctx);
		for (const key of ["Y", "x", "\r", "\t", "1", " "]) {
			captured.component.handleInput?.(key);
		}
		expect(captured.done).not.toHaveBeenCalled();
		// Settle so the test exits.
		resolveCustomRef.current("no");
		await handle.decision;
	});
});

describe("promptSelection — non-TUI fallback", () => {
	it("resolves 'cancelled' when ctx.ui.custom returns undefined (RPC mode)", async () => {
		const ctx = {
			ui: {
				custom: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as Parameters<typeof promptSelection>[0];
		const handle = promptSelection(ctx);
		expect(await handle.decision).toBe("cancelled");
		// dismiss() must be safe with no component ever created.
		handle.dismiss();
		expect(await handle.decision).toBe("cancelled");
	});
});

describe("promptSelection — remote dismissal", () => {
	it("dismiss() resolves 'cancelled' and tears the component down", async () => {
		const { ctx, captured } = makeCtxWithCapturedCustom();
		const handle = promptSelection(ctx);
		handle.dismiss();
		// pi's done() must be called so the editor is restored...
		expect(captured.done).toHaveBeenCalledWith("cancelled");
		// ...and the decision promise must settle without a keypress.
		expect(await handle.decision).toBe("cancelled");
	});

	it("dismiss() after a keypress is a no-op (first answer wins)", async () => {
		const { ctx, captured } = makeCtxWithCapturedCustom();
		const handle = promptSelection(ctx);
		captured.component.handleInput?.("y");
		handle.dismiss();
		expect(captured.done).toHaveBeenCalledTimes(1);
		expect(captured.done).toHaveBeenCalledWith("yes");
		expect(await handle.decision).toBe("yes");
	});

	it("keypress after dismiss() is a no-op", async () => {
		const { ctx, captured } = makeCtxWithCapturedCustom();
		const handle = promptSelection(ctx);
		handle.dismiss();
		captured.component.handleInput?.("y");
		expect(captured.done).toHaveBeenCalledTimes(1);
		expect(await handle.decision).toBe("cancelled");
	});
});

/**
 * Parallel helper for `promptOptions` — captures the factory and a
 * handle to settle the outer promise. Mirrors `makeCtxWithCapturedCustom`
 * but typed against `OptionsDecision`.
 */
function makeOptionsCtxWithCapturedCustom(): {
	ctx: Parameters<typeof promptOptions>[0];
	resolveOptionsCustomRef: {
		current: (decision: OptionsDecision | undefined) => void;
	};
	captured: CapturedFactory;
} {
	const captured = {} as CapturedFactory;
	const resolveOptionsCustomRef: {
		current: (decision: OptionsDecision | undefined) => void;
	} = { current: () => {} };
	const custom = vi.fn(
		(
			factory: (
				tui: unknown,
				theme: ReturnType<typeof makeTheme>,
				keybindings: unknown,
				done: (decision: OptionsDecision) => void,
			) => unknown,
		) => {
			const theme = makeTheme();
			captured.tui = {};
			captured.theme = theme;
			captured.keybindings = {};
			const done = vi.fn((decision: OptionsDecision) => {
				resolveOptionsCustomRef.current(decision);
			});
			captured.done = done;
			captured.component = factory(
				captured.tui,
				theme,
				captured.keybindings,
				done,
			) as CapturedFactory["component"];
			return new Promise<OptionsDecision | undefined>((resolve) => {
				resolveOptionsCustomRef.current = (decision) => resolve(decision);
			});
		},
	);
	const ctx = { ui: { custom } } as unknown as Parameters<
		typeof promptOptions
	>[0];
	return { ctx, resolveOptionsCustomRef, captured };
}

describe("promptOptions — component lifecycle", () => {
	it("calls ctx.ui.custom (no overlay) with title and option list", async () => {
		const { ctx, resolveOptionsCustomRef, captured } =
			makeOptionsCtxWithCapturedCustom();
		const handle = promptOptions(ctx, "Pick one:", ["yes", "no"]);
		expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
		const [factory, options] = (ctx.ui.custom as ReturnType<typeof vi.fn>).mock
			.calls[0] as [unknown, unknown];
		expect(typeof factory).toBe("function");
		if (options !== undefined) {
			expect((options as { overlay?: boolean }).overlay).not.toBe(true);
		}
		expect(captured.component).toBeDefined();
		expect(typeof captured.component.render).toBe("function");
		expect(typeof captured.component.invalidate).toBe("function");
		expect(typeof captured.component.handleInput).toBe("function");
		// Settle so the test exits cleanly.
		resolveOptionsCustomRef.current({ label: "yes" });
		await handle.decision;
	});

	it("renders the title and every numbered option", async () => {
		const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
		const handle = promptOptions(ctx, "Pick:", ["alpha", "beta", "gamma"]);
		const lines = captured.component.render(40);
		const joined = lines.join("\n");
		expect(joined).toContain("Pick:");
		expect(joined).toContain("1. alpha");
		expect(joined).toContain("2. beta");
		expect(joined).toContain("3. gamma");
		// Bordered: top + title + 3 options + bottom = 6.
		expect(lines).toHaveLength(6);
		// Don't leave a dangling promise.
		handle.dismiss();
	});
});

describe("promptOptions — key mapping", () => {
	for (let n = 1; n <= 9; n++) {
		const option = `opt${n}`;
		it(`maps key '${n}' to { label: '${option}' } when options[${n - 1}] exists`, async () => {
			const options = [
				"opt1",
				"opt2",
				"opt3",
				"opt4",
				"opt5",
				"opt6",
				"opt7",
				"opt8",
				"opt9",
			];
			const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
			const handle = promptOptions(ctx, "Pick:", options);
			captured.component.handleInput?.(String(n));
			expect(captured.done).toHaveBeenCalledWith({ label: option });
			expect(await handle.decision).toEqual({ label: option });
		});
	}

	it("ignores digit keys with no matching option (out-of-range)", async () => {
		const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
		const handle = promptOptions(ctx, "Pick:", ["only"]);
		captured.component.handleInput?.("5");
		expect(captured.done).not.toHaveBeenCalled();
		handle.dismiss();
	});

	it("ignores non-digit keys (no spurious cancel)", async () => {
		const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
		const handle = promptOptions(ctx, "Pick:", ["only"]);
		for (const key of ["a", " ", "\r", "\t", "0", "Y", "1a"]) {
			captured.component.handleInput?.(key);
		}
		expect(captured.done).not.toHaveBeenCalled();
		handle.dismiss();
	});

	for (const escKey of ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1;27~"]) {
		it(`maps escape (${JSON.stringify(escKey)}) to 'cancelled'`, async () => {
			const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
			const handle = promptOptions(ctx, "Pick:", ["a"]);
			captured.component.handleInput?.(escKey);
			expect(captured.done).toHaveBeenCalledWith("cancelled");
			expect(await handle.decision).toBe("cancelled");
		});
	}
});

describe("promptOptions — non-TUI fallback", () => {
	it("resolves 'cancelled' when ctx.ui.custom returns undefined (RPC mode)", async () => {
		const ctx = {
			ui: {
				custom: vi.fn().mockResolvedValue(undefined),
			},
		} as unknown as Parameters<typeof promptOptions>[0];
		const handle = promptOptions(ctx, "Pick:", ["a"]);
		expect(await handle.decision).toBe("cancelled");
		// dismiss() must be safe with no component ever created.
		handle.dismiss();
		expect(await handle.decision).toBe("cancelled");
	});
});

describe("promptOptions — remote dismissal", () => {
	it("dismiss() resolves 'cancelled' and tears the component down", async () => {
		const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
		const handle = promptOptions(ctx, "Pick:", ["a"]);
		handle.dismiss();
		expect(captured.done).toHaveBeenCalledWith("cancelled");
		expect(await handle.decision).toBe("cancelled");
	});

	it("dismiss() after a keypress is a no-op (first answer wins)", async () => {
		const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
		const handle = promptOptions(ctx, "Pick:", ["a", "b"]);
		captured.component.handleInput?.("1");
		handle.dismiss();
		expect(captured.done).toHaveBeenCalledTimes(1);
		expect(captured.done).toHaveBeenCalledWith({ label: "a" });
		expect(await handle.decision).toEqual({ label: "a" });
	});

	it("keypress after dismiss() is a no-op", async () => {
		const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
		const handle = promptOptions(ctx, "Pick:", ["a"]);
		handle.dismiss();
		captured.component.handleInput?.("1");
		expect(captured.done).toHaveBeenCalledTimes(1);
		expect(await handle.decision).toBe("cancelled");
	});
});

describe("promptOptions — single-resolution guarantee", () => {
	it("decision settles exactly once even if many inputs race", async () => {
		const { ctx, captured } = makeOptionsCtxWithCapturedCustom();
		const handle = promptOptions(ctx, "Pick:", ["a", "b", "c"]);
		captured.component.handleInput?.("1");
		captured.component.handleInput?.("2");
		captured.component.handleInput?.("\x1b");
		expect(captured.done).toHaveBeenCalledTimes(1);
		expect(captured.done).toHaveBeenCalledWith({ label: "a" });
		const settled = await handle.decision;
		expect(settled).toEqual({ label: "a" });
	});
});

describe("isEscapeKey — exported for mirror reuse", () => {
	it("matches the same set of escape byte forms as the gate", async () => {
		const { isEscapeKey } = await import("../src/ui.js");
		for (const esc of ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1;27~"]) {
			expect(isEscapeKey(esc)).toBe(true);
		}
		for (const notEsc of ["y", "1", "\r", "", "\x1b[5u"]) {
			expect(isEscapeKey(notEsc)).toBe(false);
		}
	});
});
