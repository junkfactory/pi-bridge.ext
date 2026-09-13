/**
 * Tests for the UI prompt mirror.
 *
 * Covers Step 3 of the plan:
 *   - Pass-through when env kill switch, mirrorReady=false, or
 *     !nvimTurnActive
 *   - Select first-wins both directions; confirm contract; cancel→false
 *   - Custom: capture-on-change (one broadcast for two identical renders),
 *     key injection reaches handleInput, done→resolved-once,
 *     component-without-handleInput untouched, async factory works
 *   - reset() settles pending as cancelled
 *   - Double-install idempotent
 *   - ui_prompt_resolved broadcast exactly once per id
 *
 * Uses fakes for broadcast, ui, and ctx — no real sockets, no real TUI.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createMirror,
	installMirror,
	isMirrorReady,
	setMirror,
	setMirrorReady,
} from "../src/prompt_mirror.js";
import { setNvimTurnActive } from "../src/turn.js";
import { GATE_PROMPT_KEY } from "../src/ui.js";

function makeTheme() {
	initTheme("dark");
	const sym = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const t = (globalThis as Record<symbol, unknown>)[sym];
	if (!t) throw new Error("Theme not initialized");
	return t;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Broadcast {
	emit: ReturnType<typeof vi.fn>;
	/** All broadcasts as parsed JSON, oldest first. */
	events: Array<Record<string, unknown>>;
}

function makeBroadcast(): Broadcast {
	const emit = vi.fn();
	const events: Array<Record<string, unknown>> = [];
	emit.mockImplementation((data: string) => {
		const trimmed = data.trim();
		if (trimmed.length > 0) {
			try {
				events.push(JSON.parse(trimmed));
			} catch {
				// not JSON; ignore for event-collection purposes
			}
		}
	});
	return { emit, events };
}

function makeUi(overrides?: Record<string, unknown>) {
	return {
		select: vi.fn(
			async (_title: string, options: readonly string[]) =>
				options[0] ?? undefined,
		),
		confirm: vi.fn(async () => true),
		custom: vi.fn(async () => undefined),
		notify: vi.fn(),
		...overrides,
	} as unknown as ExtensionContext["ui"];
}

function makeCtx(ui: ExtensionContext["ui"]): ExtensionContext {
	return {
		ui,
		model: undefined,
		cwd: "/tmp/fake",
		hasUI: true,
		sessionManager: { getSessionId: () => "test-session" },
		signal: undefined,
		getContextUsage: () => undefined,
		thinkingLevel: undefined,
	} as unknown as ExtensionContext;
}

interface CapturedCustom {
	factory: (
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
		done: (decision: unknown) => void,
	) => unknown;
	options: unknown;
	resolveCustomRef: { current: (decision: unknown) => void };
}

function makeUiWithCapturedCustom(): {
	ui: ExtensionContext["ui"];
	captured: CapturedCustom;
} {
	const captured: CapturedCustom = {
		factory: () => undefined,
		options: undefined,
		resolveCustomRef: { current: () => {} },
	};
	const custom = vi.fn(
		(
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (decision: unknown) => void,
			) => unknown,
			options?: unknown,
		) => {
			const theme = makeTheme();
			const done = vi.fn((decision: unknown) => {
				captured.resolveCustomRef.current(decision);
			});
			captured.factory = factory;
			captured.options = options;
			return new Promise<unknown>((resolve) => {
				captured.resolveCustomRef.current = (decision) => resolve(decision);
				// Suppress the unused-binding lint for `theme` — kept for
				// parity with pi's real signature so tests don't accidentally
				// pass a fake shape that masks a real bug.
				void theme;
				void done;
			});
		},
	);
	const ui = makeUi({ custom });
	return { ui, captured };
}

interface MirrorComponent {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	dispose?(): void;
}

/** Build a mirror-able ComponentLike. */
function makeMirrorableComponent(initialLines: string[]): MirrorComponent & {
	origRender: ReturnType<typeof vi.fn>;
} {
	const origRender = vi.fn((_width: number) => [...initialLines]);
	const comp = {
		render: origRender,
		invalidate: vi.fn(),
		handleInput: vi.fn(),
		origRender,
	};
	return comp as MirrorComponent & { origRender: ReturnType<typeof vi.fn> };
}

// ---------------------------------------------------------------------------
// Setup / teardown — reset every piece of shared state.
// ---------------------------------------------------------------------------

beforeEach(() => {
	// Default kill switch: NOT set.
	delete process.env.PI_BRIDGE_UI_PROMPT_MIRROR;
	// Default: nvim turn NOT active; mirror NOT ready.
	setNvimTurnActive(false);
	setMirrorReady(false);
	setMirror(null);
});

afterEach(() => {
	delete process.env.PI_BRIDGE_UI_PROMPT_MIRROR;
	setNvimTurnActive(false);
	setMirrorReady(false);
	setMirror(null);
});

// ---------------------------------------------------------------------------
// isActive gate
// ---------------------------------------------------------------------------

describe("Mirror — isActive gating", () => {
	it("returns false when the env kill switch is set", () => {
		process.env.PI_BRIDGE_UI_PROMPT_MIRROR = "0";
		setMirrorReady(true);
		setNvimTurnActive(true);
		const m = createMirror({ broadcast: vi.fn() });
		expect(m.isActive()).toBe(false);
	});

	it("returns false when mirrorReady is false", () => {
		setMirrorReady(false);
		setNvimTurnActive(true);
		const m = createMirror({ broadcast: vi.fn() });
		expect(m.isActive()).toBe(false);
	});

	it("returns false when not in an nvim turn", () => {
		setMirrorReady(true);
		setNvimTurnActive(false);
		const m = createMirror({ broadcast: vi.fn() });
		expect(m.isActive()).toBe(false);
	});

	it("returns true when all three conditions hold", () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const m = createMirror({ broadcast: vi.fn() });
		expect(m.isActive()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// installMirror wrappers — pass-through paths
// ---------------------------------------------------------------------------

describe("installMirror — pass-through", () => {
	it("falls through to the original select when env kill switch is set", async () => {
		process.env.PI_BRIDGE_UI_PROMPT_MIRROR = "0";
		setMirrorReady(true);
		setNvimTurnActive(true);
		const ui = makeUi();
		const original = ui.select as ReturnType<typeof vi.fn>;
		const ctx = makeCtx(ui);
		installMirror(ctx);
		await ctx.ui.select("Pick:", ["a", "b"]);
		expect(original).toHaveBeenCalledOnce();
	});

	it("falls through to the original select when mirrorReady is false", async () => {
		setMirrorReady(false);
		setNvimTurnActive(true);
		const ui = makeUi();
		const original = ui.select as ReturnType<typeof vi.fn>;
		const ctx = makeCtx(ui);
		installMirror(ctx);
		await ctx.ui.select("Pick:", ["a", "b"]);
		expect(original).toHaveBeenCalledOnce();
	});

	it("falls through to the original select when not in an nvim turn", async () => {
		setMirrorReady(true);
		setNvimTurnActive(false);
		const ui = makeUi();
		const original = ui.select as ReturnType<typeof vi.fn>;
		const ctx = makeCtx(ui);
		installMirror(ctx);
		await ctx.ui.select("Pick:", ["a", "b"]);
		expect(original).toHaveBeenCalledOnce();
	});

	it("falls through when opts.signal is already aborted (select)", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const ui = makeUi();
		const original = ui.select as ReturnType<typeof vi.fn>;
		const ctx = makeCtx(ui);
		installMirror(ctx);
		const ac = new AbortController();
		ac.abort();
		await ctx.ui.select("Pick:", ["a", "b"], { signal: ac.signal });
		expect(original).toHaveBeenCalledOnce();
		// Original was called with the same opts — signal preserved.
		expect(original.mock.calls[0][2]).toEqual({ signal: ac.signal });
	});

	it("falls through when opts.signal is already aborted (confirm)", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const ui = makeUi();
		const original = ui.confirm as ReturnType<typeof vi.fn>;
		const ctx = makeCtx(ui);
		installMirror(ctx);
		const ac = new AbortController();
		ac.abort();
		await ctx.ui.confirm("Are you sure?", "msg", { signal: ac.signal });
		expect(original).toHaveBeenCalledOnce();
	});

	it("forwards message to the original confirm (pass-through path)", async () => {
		setMirrorReady(true);
		setNvimTurnActive(false);
		const ui = makeUi();
		const original = ui.confirm as ReturnType<typeof vi.fn>;
		const ctx = makeCtx(ui);
		installMirror(ctx);
		await ctx.ui.confirm("Title", "Important question body");
		expect(original).toHaveBeenCalledOnce();
		expect(original.mock.calls[0][1]).toBe("Important question body");
	});
});

// ---------------------------------------------------------------------------
// Select: first-wins race
// ---------------------------------------------------------------------------

describe("Mirror — select first-wins", () => {
	it("nvim wins (value) → returns the label and broadcasts resolved", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);
		const original = vi.fn(
			async (_t: string, _o: readonly string[]) => "ORIGINAL",
		);

		const promise = mirror.runSelect(ctx, "Pick:", ["a", "b"], original);

		// The mirror must have broadcast a ui_prompt_request with kind=select.
		expect(bc.events).toHaveLength(1);
		expect(bc.events[0]).toMatchObject({
			type: "ui_prompt_request",
			kind: "select",
			title: "Pick:",
			options: ["a", "b"],
		});
		const id = bc.events[0].id as string;
		expect(typeof id).toBe("string");

		// pi-side factory was invoked (rendered prompt).
		expect(ui.custom).toHaveBeenCalledTimes(1);

		// Nvim answers with the label.
		mirror.handleResponse(id, { kind: "value", value: "a" });

		expect(await promise).toBe("a");
		// Resolved broadcast exactly once.
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);
		expect(bc.events.at(-1)).toMatchObject({
			type: "ui_prompt_resolved",
			id,
		});

		// Loser (pi-side) was dismissed: handleInput/Esc/done called.
		// We assert via the captured factory — its done() callback (the
		// outer piPromise resolver) is what dismiss() eventually calls.
		// Settle the promise so the test exits cleanly.
		captured.resolveCustomRef.current("cancelled");
	});

	it("pi wins (label) → returns the label and broadcasts resolved", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);
		const original = vi.fn(
			async (_t: string, _o: readonly string[]) => "ORIGINAL",
		);

		const promise = mirror.runSelect(ctx, "Pick:", ["a", "b"], original);
		// Wait for the request to be broadcast so we know the id exists.
		await flushMicrotasks();

		const id = bc.events[0].id as string;

		// Pi user picks "b" via the captured factory.
		captured.resolveCustomRef.current({ label: "b" });
		await flushMicrotasks();

		expect(await promise).toBe("b");
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);
		expect(bc.events.at(-1)).toMatchObject({
			type: "ui_prompt_resolved",
			id,
		});
	});

	it("pi wins (cancelled) → returns undefined and broadcasts resolved", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);
		const original = vi.fn(async () => "ORIGINAL");

		const promise = mirror.runSelect(ctx, "Pick:", ["a", "b"], original);
		await flushMicrotasks();

		captured.resolveCustomRef.current("cancelled");
		await flushMicrotasks();

		expect(await promise).toBeUndefined();
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);
	});

	it("nvim wins (cancelled) → returns undefined and broadcasts resolved", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);
		const original = vi.fn(async () => "ORIGINAL");

		const promise = mirror.runSelect(ctx, "Pick:", ["a", "b"], original);

		const id = bc.events[0].id as string;
		mirror.handleResponse(id, { kind: "cancelled" });

		expect(await promise).toBeUndefined();
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);

		// Clean up the dangling pi promise.
		captured.resolveCustomRef.current("cancelled");
	});

	it("unknown id response is a no-op (no second broadcast)", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const promise = mirror.runSelect(
			ctx,
			"Pick:",
			["a", "b"],
			vi.fn(async () => "ORIGINAL"),
		);
		await flushMicrotasks();

		// Bogus id: no exception, no extra broadcast.
		mirror.handleResponse("not-an-id", { kind: "value", value: "a" });

		// Real id still works.
		const id = bc.events[0].id as string;
		mirror.handleResponse(id, { kind: "value", value: "a" });
		expect(await promise).toBe("a");

		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);

		captured.resolveCustomRef.current("cancelled");
	});
});

// ---------------------------------------------------------------------------
// Confirm contract
// ---------------------------------------------------------------------------

describe("Mirror — confirm contract", () => {
	it("nvim 'Yes' → true", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const promise = mirror.runConfirm(
			ctx,
			"Proceed?",
			"msg",
			vi.fn(async () => true),
		);

		const id = bc.events[0].id as string;
		expect(bc.events[0]).toMatchObject({
			type: "ui_prompt_request",
			kind: "confirm",
			options: ["Yes", "No"],
		});
		mirror.handleResponse(id, { kind: "value", value: "Yes" });
		expect(await promise).toBe(true);

		captured.resolveCustomRef.current("cancelled");
	});

	it("nvim cancel → false", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const promise = mirror.runConfirm(
			ctx,
			"Proceed?",
			"msg",
			vi.fn(async () => true),
		);
		const id = bc.events[0].id as string;
		mirror.handleResponse(id, { kind: "cancelled" });
		expect(await promise).toBe(false);

		captured.resolveCustomRef.current("cancelled");
	});

	it("nvim 'No' → false (any non-Yes label is false)", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const promise = mirror.runConfirm(
			ctx,
			"Proceed?",
			"msg",
			vi.fn(async () => true),
		);
		const id = bc.events[0].id as string;
		mirror.handleResponse(id, { kind: "value", value: "No" });
		expect(await promise).toBe(false);

		captured.resolveCustomRef.current("cancelled");
	});

	it("pi 'Yes' → true and broadcasts resolved", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const promise = mirror.runConfirm(
			ctx,
			"Proceed?",
			"msg",
			vi.fn(async () => true),
		);
		await flushMicrotasks();
		captured.resolveCustomRef.current({ label: "Yes" });
		await flushMicrotasks();
		expect(await promise).toBe(true);
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Custom: feature-detect pass-through
// ---------------------------------------------------------------------------

describe("Mirror — custom pass-through", () => {
	it("component without render() → no broadcast, no wrap", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const noRender: Partial<MirrorComponent> = {
			invalidate: vi.fn(),
			handleInput: vi.fn(),
		};

		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
				_opts?: unknown,
			) => {
				const result = (await factory(
					{},
					makeTheme(),
					{},
					() => {},
				)) as MirrorComponent;
				expect(result).toBe(noRender); // returned untouched
				return "ORIGINAL-RESULT";
			},
		);

		const userFactory = vi.fn(() => noRender as MirrorComponent);
		const result = await mirror.runCustom(
			ctx,
			userFactory,
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);
		expect(result).toBe("ORIGINAL-RESULT");
		expect(bc.events).toHaveLength(0);

		// Clean up: settle any dangling pi promise (none expected, but
		// be safe).
		void captured;
	});

	it("component without handleInput() → no broadcast, no wrap", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const noHandleInput: Partial<MirrorComponent> = {
			render: vi.fn(() => ["line"]),
			invalidate: vi.fn(),
		};

		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => {
				const result = (await factory(
					{},
					makeTheme(),
					{},
					() => {},
				)) as MirrorComponent;
				expect(result).toBe(noHandleInput); // returned untouched
				return "ORIGINAL-RESULT";
			},
		);

		const result = await mirror.runCustom(
			ctx,
			vi.fn(() => noHandleInput as unknown as MirrorComponent),
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);
		expect(result).toBe("ORIGINAL-RESULT");
		expect(bc.events).toHaveLength(0);
	});

	it("gate's own prompt (GATE_PROMPT_KEY) → pass-through, no broadcast", async () => {
		// The edit-approval gate's promptSelection calls ctx.ui.custom on
		// this same ui object. The mirror must pass it through untouched:
		// the gate has its own nvim surface (approval_request), and
		// mirroring it would stack a notice + modal loop on top of the
		// gate's y/a/n prompt (found live in e2e testing).
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);
		(ui as unknown as Record<string, unknown>)[GATE_PROMPT_KEY] = true;

		const gateComponent = makeMirrorableComponent(["gate"]);
		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => {
				const result = (await factory(
					{},
					makeTheme(),
					{},
					() => {},
				)) as MirrorComponent;
				expect(result).toBe(gateComponent); // returned untouched
				return "GATE-RESULT";
			},
		);

		const result = await mirror.runCustom(
			ctx,
			vi.fn(() => gateComponent as MirrorComponent),
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);
		expect(result).toBe("GATE-RESULT");
		expect(bc.events).toHaveLength(0);
		// Flag must not leak: cleanup here (ui.ts clears it in a finally
		// around its own call; we set it manually in this test).
		(ui as unknown as Record<string, unknown>)[GATE_PROMPT_KEY] = false;
	});

	it("async user factory is awaited before feature-detect", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const component = makeMirrorableComponent(["hello", "world"]);

		let resolveFactory!: (c: MirrorComponent) => void;
		const userFactory = vi.fn(
			() =>
				new Promise<MirrorComponent>((resolve) => {
					resolveFactory = resolve;
				}),
		);
		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => {
				const result = factory(
					{},
					makeTheme(),
					{},
					() => {},
				) as MirrorComponent;
				return result;
			},
		);

		const promise = mirror.runCustom(
			ctx,
			userFactory,
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);

		// While the factory is unresolved, no broadcast yet.
		await flushMicrotasks();
		expect(bc.events).toHaveLength(0);

		// Resolve with a mirror-able component.
		resolveFactory(component);

		const result = await promise;
		expect(result).toBe(component);

		// After the factory resolves, render() is called by pi's overlay
		// pipeline — but we don't drive pi directly here. We do verify
		// the wrap via the broadcast path: call component.render
		// manually, since we mutated it in place.
		const lines = result.render(40);
		expect(lines).toEqual(["hello", "world"]);
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_request"),
		).toHaveLength(1);
		expect(bc.events[0]).toMatchObject({
			type: "ui_prompt_request",
			kind: "custom",
			lines: ["hello", "world"],
		});
	});
});

// ---------------------------------------------------------------------------
// Custom: capture-on-change + key injection + done
// ---------------------------------------------------------------------------

describe("Mirror — custom capture & injection", () => {
	async function runCustomWithComponent(
		component: MirrorComponent,
	): Promise<{ result: MirrorComponent; bc: Broadcast }> {
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => {
				const result = (await factory(
					{},
					makeTheme(),
					{},
					() => {},
				)) as MirrorComponent;
				return result;
			},
		);

		const result = await mirror.runCustom(
			ctx,
			vi.fn(() => component),
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);
		return { result, bc };
	}

	it("first render broadcasts the request", async () => {
		const component = makeMirrorableComponent(["a", "b"]);
		const { bc } = await runCustomWithComponent(component);
		const lines = component.render(40);
		expect(lines).toEqual(["a", "b"]);
		expect(bc.events).toHaveLength(1);
		expect(bc.events[0]).toMatchObject({
			type: "ui_prompt_request",
			kind: "custom",
			lines: ["a", "b"],
		});
	});

	it("two identical renders produce only one broadcast", async () => {
		const component = makeMirrorableComponent(["x"]);
		const { bc } = await runCustomWithComponent(component);
		component.render(40);
		component.render(40);
		component.render(40);
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_request"),
		).toHaveLength(1);
	});

	it("renders with changed lines broadcast each change", async () => {
		const component = makeMirrorableComponent(["a"]);
		const { bc } = await runCustomWithComponent(component);
		component.render(40); // 1: first render broadcasts ["a"]
		component.render(40); // 2: same → no broadcast
		// Subsequent renders return a different (stable) lineset.
		component.origRender.mockReturnValue(["a", "b"]);
		component.render(40); // 3: changed → broadcast
		component.render(40); // 4: same → no broadcast
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_request"),
		).toHaveLength(2);
	});

	it("Escape key form is normalized to raw \\\\x1b for handleInput", async () => {
		// Drive this through the live singleton so handleResponse can
		// reach the same mirror that ran runCustom.
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		setMirror(mirror);

		const component = makeMirrorableComponent(["prompt"]);
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => factory({}, makeTheme(), {}, () => {}),
		);

		await mirror.runCustom(
			ctx,
			vi.fn(() => component),
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);

		component.render(40);
		const id = bc.events[0].id as string;

		// Inject various escape forms.
		for (const form of ["\x1b", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1;27~"]) {
			mirror.handleResponse(id, { kind: "key", key: form });
		}
		// Every invocation should have reached handleInput as raw \x1b.
		expect(component.handleInput).toHaveBeenCalledTimes(4);
		for (const call of (component.handleInput as ReturnType<typeof vi.fn>).mock
			.calls) {
			expect(call[0]).toBe("\x1b");
		}
	});

	it("non-escape key is forwarded verbatim to handleInput", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		setMirror(mirror);

		const component = makeMirrorableComponent(["prompt"]);
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => factory({}, makeTheme(), {}, () => {}),
		);
		await mirror.runCustom(
			ctx,
			vi.fn(() => component),
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);
		component.render(40);
		const id = bc.events[0].id as string;

		for (const key of ["y", "s", "n", "\x0f"]) {
			mirror.handleResponse(id, { kind: "key", key });
		}
		expect(component.handleInput).toHaveBeenCalledTimes(4);
		const calls = (component.handleInput as ReturnType<typeof vi.fn>).mock
			.calls;
		expect(calls[0][0]).toBe("y");
		expect(calls[1][0]).toBe("s");
		expect(calls[2][0]).toBe("n");
		expect(calls[3][0]).toBe("\x0f");
	});

	it("done() broadcasts ui_prompt_resolved exactly once", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		setMirror(mirror);

		const component = makeMirrorableComponent(["prompt"]);
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		// The user's component owns the done callback (the one passed
		// to the factory); it's the only legitimate settlement path for
		// a custom mirror. Capture it via the user factory.
		let capturedDone: ((decision: unknown) => void) | undefined;
		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => {
				const result = (await factory(
					{},
					makeTheme(),
					{},
					() => {},
				)) as MirrorComponent;
				return result;
			},
		);
		const userFactory = vi.fn(
			(
				_tui: unknown,
				_theme: unknown,
				_kb: unknown,
				done: (decision: unknown) => void,
			) => {
				capturedDone = done;
				return component;
			},
		);
		await mirror.runCustom(
			ctx,
			userFactory,
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);
		component.render(40); // first broadcast

		// Calling done broadcasts ui_prompt_resolved exactly once.
		expect(typeof capturedDone).toBe("function");
		capturedDone?.("yes");
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);

		// Calling done again is a no-op.
		capturedDone?.("no");
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);
	});

	it("a key payload on a structured entry is dropped (no-op)", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui, captured } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const promise = mirror.runSelect(
			ctx,
			"Pick:",
			["a", "b"],
			vi.fn(async () => "ORIGINAL"),
		);
		const id = bc.events[0].id as string;

		// key on a structured entry → no-op, no exception.
		expect(() =>
			mirror.handleResponse(id, { kind: "key", key: "y" }),
		).not.toThrow();

		// Real settlement still works.
		mirror.handleResponse(id, { kind: "value", value: "a" });
		expect(await promise).toBe("a");

		captured.resolveCustomRef.current("cancelled");
	});

	it("a value/cancelled payload on a custom entry is dropped", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		setMirror(mirror);

		const component = makeMirrorableComponent(["x"]);
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => factory({}, makeTheme(), {}, () => {}),
		);
		await mirror.runCustom(
			ctx,
			vi.fn(() => component),
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);
		component.render(40);
		const id = bc.events[0].id as string;

		// value on a custom entry → no-op.
		expect(() =>
			mirror.handleResponse(id, { kind: "value", value: "garbage" }),
		).not.toThrow();
		expect(() =>
			mirror.handleResponse(id, { kind: "cancelled" }),
		).not.toThrow();
		// Only the original request broadcast.
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_request"),
		).toHaveLength(1);
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// reset()
// ---------------------------------------------------------------------------

describe("Mirror — reset", () => {
	it("settles a pending structured prompt as cancelled", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const promise = mirror.runSelect(
			ctx,
			"Pick:",
			["a", "b"],
			vi.fn(async () => "ORIGINAL"),
		);

		mirror.reset();
		expect(await promise).toBeUndefined();
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);
	});

	it("broadcasts ui_prompt_resolved once for an in-flight custom entry", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		setMirror(mirror);

		const component = makeMirrorableComponent(["x"]);
		const { ui } = makeUiWithCapturedCustom();
		const ctx = makeCtx(ui);

		const originalCustom = vi.fn(
			async (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (decision: unknown) => void,
				) => unknown,
			) => factory({}, makeTheme(), {}, () => {}),
		);
		await mirror.runCustom(
			ctx,
			vi.fn(() => component),
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
		);
		component.render(40);

		mirror.reset();
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);
		// Subsequent reset is a no-op.
		mirror.reset();
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_resolved"),
		).toHaveLength(1);
	});

	it("does not affect the ready flag (persists across session boundaries)", () => {
		setMirrorReady(true);
		const mirror = createMirror({ broadcast: vi.fn() });
		mirror.reset();
		expect(isMirrorReady()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Idempotent install
// ---------------------------------------------------------------------------

describe("installMirror — idempotency", () => {
	it("installing twice on the same ctx does not double-wrap", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		setMirror(mirror);

		// Use the lightweight ui mock (no captured custom) for this
		// test — we just want to exercise the install path; we don't
		// need a long-running pi-side promise here.
		const ui = makeUi();
		const ctx = makeCtx(ui);
		const originalSelect = ui.select as ReturnType<typeof vi.fn>;

		const m1 = installMirror(ctx);
		const m2 = installMirror(ctx);
		expect(m1).toBe(m2);
		// ui.select was wrapped exactly once.
		await ctx.ui.select("Pick:", ["a", "b"]);
		expect(originalSelect).not.toHaveBeenCalled();

		// Settle the nvim side so the test exits cleanly.
		const id = bc.events[0]?.id as string | undefined;
		if (id) mirror.handleResponse(id, { kind: "value", value: "a" });
	});

	it("installing on a fresh ctx (different session) installs fresh wrappers", async () => {
		setMirrorReady(true);
		setNvimTurnActive(true);
		const bc = makeBroadcast();
		const mirror = createMirror({ broadcast: bc.emit });
		setMirror(mirror);

		const ctxA = makeCtx(makeUi());
		const ctxB = makeCtx(makeUi());

		installMirror(ctxA);
		installMirror(ctxB);

		await ctxA.ui.select("A:", ["x"]);
		await ctxB.ui.select("B:", ["y"]);
		expect(
			bc.events.filter((e) => e.type === "ui_prompt_request"),
		).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Drain the microtask queue. */
function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
