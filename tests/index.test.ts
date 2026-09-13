import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildStartMessage, default as extension } from "../src/index.js";
import { start, stop } from "../src/socket.js";

vi.mock("../src/socket.js", () => ({
	start: vi.fn(),
	stop: vi.fn(),
	broadcast: vi.fn(),
}));

vi.mock("../src/log.js", () => ({
	LOG_PATH: "/tmp/pi-bridge-test.log",
	logPath: () => "/tmp/pi-bridge-test.log",
	setLogLevel: vi.fn(),
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../src/path.js", () => ({
	socketPath: vi.fn(
		(cwd: string) =>
			`/tmp/pi-bridge-test-sockets/${cwd.replace(/\//g, "_")}.sock`,
	),
	ensureSocketDir: vi.fn(),
}));

function mockCtx(
	overrides?: Partial<ExtensionContext>,
	notify?: ReturnType<typeof vi.fn>,
	sessionId?: string,
): ExtensionContext {
	return {
		model: { name: "Claude", id: "claude-sonnet-4" },
		thinkingLevel: "medium",
		getContextUsage: () => ({ percent: 50 }),
		cwd: "/tmp/fake-project",
		hasUI: true,
		ui: {
			notify: notify ?? vi.fn(),
			setWidget: vi.fn(),
			custom: vi.fn(),
		},
		sessionManager: { getSessionId: () => sessionId ?? "test-session-id" },
		signal: undefined,
		...overrides,
	} as unknown as ExtensionContext;
}

/** A ctx whose sessionManager throws when used after it went stale. */
function staleableCtx(sessionId: string): {
	ctx: ExtensionContext;
	markStale: () => void;
} {
	const ctx = mockCtx(undefined, undefined, sessionId);
	let stale = false;
	(
		ctx.sessionManager as unknown as { getSessionId: () => string }
	).getSessionId = () => {
		if (stale) {
			throw new Error(
				"This extension ctx is stale after session replacement or reload.",
			);
		}
		return sessionId;
	};
	return { ctx, markStale: () => (stale = true) };
}

/** Register the extension and return its event handlers plus the pi mock. */
function registerExtension(): {
	handlers: Record<
		string,
		(event: any, ctx: ExtensionContext) => Promise<void> | void
	>;
	pi: { sendUserMessage: ReturnType<typeof vi.fn> };
} {
	const handlers: Record<
		string,
		(event: any, ctx: ExtensionContext) => Promise<void> | void
	> = {};
	const pi = {
		on: vi.fn(
			(
				event: string,
				handler: (event: any, ctx: ExtensionContext) => Promise<void> | void,
			) => {
				handlers[event] = handler;
			},
		),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	extension(pi);
	return { handlers, pi: pi as { sendUserMessage: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
	vi.mocked(start).mockReset().mockResolvedValue({ status: "started" });
	vi.mocked(stop).mockReset().mockResolvedValue(undefined);
	// Clear the global state between tests
	const g = globalThis as typeof globalThis & {
		__piBridgeOwnerSessionId?: string | null;
		__piBridgePiMap?: Map<string, unknown>;
		__piBridgeNvimTurnActive?: boolean;
	};
	g.__piBridgeOwnerSessionId = null;
	g.__piBridgePiMap = new Map();
	g.__piBridgeNvimTurnActive = false;
});

describe("buildStartMessage", () => {
	it("includes model name and thinking level", () => {
		const msg = buildStartMessage(mockCtx());
		expect(msg).toBe("Claude is thinking in medium at 50.00% brain usage");
	});

	it("rounds brain usage to two decimal places", () => {
		const msg = buildStartMessage(
			mockCtx({ getContextUsage: () => ({ percent: 12.3456 }) }),
		);
		expect(msg).toContain("at 12.35% brain usage");
	});

	it("falls back to model id when name is missing", () => {
		const msg = buildStartMessage(
			mockCtx({ model: { id: "claude-sonnet-4" } } as any),
		);
		expect(msg).toContain("claude-sonnet-4");
	});

	it("uses 'agent' when model is undefined", () => {
		const msg = buildStartMessage(mockCtx({ model: undefined } as any));
		expect(msg).toContain("agent");
	});

	it("omits thinking level when undefined", () => {
		const msg = buildStartMessage(mockCtx({ thinkingLevel: undefined } as any));
		expect(msg).toBe("Claude is thinking at 50.00% brain usage");
	});

	it("treats 'off' thinking level as no thinking level", () => {
		const msg = buildStartMessage(mockCtx({ thinkingLevel: "off" }));
		expect(msg).toBe("Claude is thinking at 50.00% brain usage");
		expect(msg).not.toContain("in off");
	});

	it("includes valid thinking levels", () => {
		for (const level of [
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		] as const) {
			const msg = buildStartMessage(mockCtx({ thinkingLevel: level }));
			expect(msg).toContain(`in ${level}`);
		}
	});

	it("omits brain usage when percent is null", () => {
		const msg = buildStartMessage(
			mockCtx({ getContextUsage: () => ({ percent: null }) } as any),
		);
		expect(msg).not.toContain("brain usage");
	});

	it("omits brain usage when percent is 0", () => {
		const msg = buildStartMessage(
			mockCtx({ getContextUsage: () => ({ percent: 0 }) }),
		);
		expect(msg).not.toContain("brain usage");
	});

	it("omits brain usage when getContextUsage returns undefined", () => {
		const msg = buildStartMessage(
			mockCtx({ getContextUsage: () => undefined }),
		);
		expect(msg).not.toContain("brain usage");
	});
});

describe("extension socket lifecycle", () => {
	it("starts the socket on session_start", async () => {
		const { handlers } = registerExtension();
		await handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(),
		);

		expect(start).toHaveBeenCalledTimes(1);
		expect(stop).not.toHaveBeenCalled();
	});

	it("keeps the socket across session switches (new, resume, fork, reload)", async () => {
		const { handlers } = registerExtension();
		for (const reason of ["new", "resume", "fork", "reload"] as const) {
			await handlers.session_shutdown(
				{ type: "session_shutdown", reason },
				mockCtx(),
			);
		}
		expect(stop).not.toHaveBeenCalled();
	});

	it("stops the socket on quit", async () => {
		const { handlers } = registerExtension();
		// Must start first so this pi instance becomes the owner
		await handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(),
		);
		await handlers.session_shutdown(
			{ type: "session_shutdown", reason: "quit" },
			mockCtx(),
		);
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("keeps the socket when a child session (non-owner) shuts down", async () => {
		// Parent session starts and becomes the owner
		const parent = registerExtension();
		await parent.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, undefined, "parent-session"),
		);

		// Child session (different pi instance) loads the extension
		const child = registerExtension();

		// Child session shuts down with reason "quit" (as pi-subagents does)
		await child.handlers.session_shutdown(
			{ type: "session_shutdown", reason: "quit" },
			mockCtx(undefined, undefined, "child-session"),
		);

		// Parent's socket must still be alive
		expect(stop).not.toHaveBeenCalled();
	});

	it("notifies when another pi instance owns the socket", async () => {
		vi.mocked(start).mockResolvedValue({ status: "foreign-owner" });
		const notify = vi.fn();
		const { handlers } = registerExtension();

		await handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, notify),
		);

		expect(notify).toHaveBeenCalledWith(
			"pi-bridge: another pi instance is running for this directory — pi-bridge not hosting this session",
			"warning",
		);
	});

	it("does not notify when hosting normally on startup", async () => {
		const notify = vi.fn();
		const { handlers } = registerExtension();

		await handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, notify),
		);

		expect(notify).not.toHaveBeenCalled();
	});

	it("does not notify for already-hosted sessions after a switch", async () => {
		vi.mocked(start).mockResolvedValue({ status: "already-hosted" });
		const notify = vi.fn();
		const { handlers } = registerExtension();

		await handlers.session_start(
			{ type: "session_start", reason: "new" },
			mockCtx(undefined, notify),
		);

		expect(notify).not.toHaveBeenCalled();
	});

	it("dispatches inbound messages to the latest extension instance after session replacement", async () => {
		// The socket's message callback is registered by the first instance and
		// outlives session replacement (/new, /resume...). The captured `pi` and
		// `ctx` of the first instance are stale, so dispatch must resolve the
		// latest one and never touch the captured ctx.
		let onMessage: ((raw: string) => void) | undefined;
		vi.mocked(start).mockImplementation(async (_path, cb) => {
			onMessage ??= cb; // first bind wins; later instances adopt (already-hosted)
			return { status: "started" };
		});

		const first = registerExtension();
		const firstSession = staleableCtx("session-1");
		await first.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			firstSession.ctx,
		);

		// Simulate session replacement: first session shuts down, new one starts
		await first.handlers.session_shutdown(
			{ type: "session_shutdown", reason: "new" },
			mockCtx(undefined, undefined, "session-1"),
		);

		const second = registerExtension();
		await second.handlers.session_start(
			{ type: "session_start", reason: "new" },
			mockCtx(undefined, undefined, "session-2"),
		);

		// The first instance's ctx is now stale — the callback must not use it.
		firstSession.markStale();

		onMessage?.(
			JSON.stringify({
				type: "prompt",
				text: "hello from nvim",
				context: {
					file: new URL(import.meta.url).pathname,
					cwd: "/tmp",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);

		expect(first.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(second.pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("hello from nvim"),
		);
	});

	it("delivers messages when pi rebinds the extension at startup (same session, second instance)", async () => {
		// Fresh `pi -c` launches evaluate the extension factory twice for the
		// same session: instance 1 binds the socket (and its callback), instance
		// 2 takes over the map entry and is the live runtime. The callback from
		// instance 1 must still deliver messages — without using its stale ctx.
		let onMessage: ((raw: string) => void) | undefined;
		vi.mocked(start).mockImplementation(async (_path, cb) => {
			onMessage ??= cb; // first bind wins
			return { status: "started" };
		});

		const first = registerExtension();
		const firstSession = staleableCtx("session-1");
		await first.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			firstSession.ctx,
		);

		// pi rebinds: same session id, fresh extension instance; its ctx is the
		// live one and the stale one must never be touched.
		firstSession.markStale();
		const second = registerExtension();
		await second.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, undefined, "session-1"),
		);

		onMessage?.(
			JSON.stringify({
				type: "prompt",
				text: "hello from nvim",
				context: {
					file: new URL(import.meta.url).pathname,
					cwd: "/tmp",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);

		expect(first.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(second.pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("hello from nvim"),
		);
	});

	it("dispatches inbound messages to the resumed session after /resume", async () => {
		let onMessage: ((raw: string) => void) | undefined;
		vi.mocked(start).mockImplementation(async (_path, cb) => {
			onMessage ??= cb;
			return { status: "started" };
		});

		const first = registerExtension();
		const originalSession = staleableCtx("session-1");
		await first.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			originalSession.ctx,
		);

		// /resume: session_before_switch is a pi-internal hook the extension
		// does not listen to; the extension sees shutdown + session_start.
		await first.handlers.session_shutdown(
			{ type: "session_shutdown", reason: "resume" },
			mockCtx(undefined, undefined, "session-1"),
		);
		const resumed = registerExtension();
		await resumed.handlers.session_start(
			{
				type: "session_start",
				reason: "resume",
				previousSessionFile: "/tmp/s1.jsonl",
			},
			mockCtx(undefined, undefined, "session-2"),
		);

		// The original session's ctx is stale from here on.
		originalSession.markStale();

		onMessage?.(
			JSON.stringify({
				type: "prompt",
				text: "hello from nvim",
				context: {
					file: new URL(import.meta.url).pathname,
					cwd: "/tmp",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);

		expect(first.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(resumed.pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("hello from nvim"),
		);
	});

	it("dispatches inbound messages after consecutive /new and /resume switches", async () => {
		// The callback is bound once at the very first session_start and must
		// keep working across any number of subsequent session switches — each
		// switch rebinds extensions and makes the previous ctx stale.
		let onMessage: ((raw: string) => void) | undefined;
		vi.mocked(start).mockImplementation(async (_path, cb) => {
			onMessage ??= cb;
			return { status: "started" };
		});

		const boot = registerExtension();
		const bootSession = staleableCtx("session-1");
		await boot.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			bootSession.ctx,
		);

		// /new — new extension instance takes over the map entry
		await boot.handlers.session_shutdown(
			{ type: "session_shutdown", reason: "new" },
			mockCtx(undefined, undefined, "session-1"),
		);
		bootSession.markStale();
		const afterNew = registerExtension();
		await afterNew.handlers.session_start(
			{ type: "session_start", reason: "new" },
			mockCtx(undefined, undefined, "session-2"),
		);

		// /resume — another instance, the message must land here
		await afterNew.handlers.session_shutdown(
			{ type: "session_shutdown", reason: "resume" },
			mockCtx(undefined, undefined, "session-2"),
		);
		const afterResume = registerExtension();
		await afterResume.handlers.session_start(
			{
				type: "session_start",
				reason: "resume",
				previousSessionFile: "/tmp/s2.jsonl",
			},
			mockCtx(undefined, undefined, "session-3"),
		);

		onMessage?.(
			JSON.stringify({
				type: "prompt",
				text: "hello from nvim",
				context: {
					file: new URL(import.meta.url).pathname,
					cwd: "/tmp",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);

		expect(boot.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(afterNew.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(afterResume.pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("hello from nvim"),
		);
	});

	it("does not overwrite active pi when a subagent session starts", async () => {
		let onMessage: ((raw: string) => void) | undefined;
		vi.mocked(start).mockImplementation(async (_path, cb) => {
			onMessage ??= cb;
			return { status: "started" };
		});

		const parent = registerExtension();
		await parent.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, undefined, "parent-session"),
		);

		// Subagent starts with a different session ID
		const child = registerExtension();
		await child.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, undefined, "child-session"),
		);

		// Messages should still go to parent
		onMessage?.(
			JSON.stringify({
				type: "prompt",
				text: "hello",
				context: {
					file: new URL(import.meta.url).pathname,
					cwd: "/tmp",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);

		expect(parent.pi.sendUserMessage).toHaveBeenCalled();
		expect(child.pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("preserves parent active pi when child session shuts down", async () => {
		let onMessage: ((raw: string) => void) | undefined;
		vi.mocked(start).mockImplementation(async (_path, cb) => {
			onMessage ??= cb;
			return { status: "started" };
		});

		const parent = registerExtension();
		await parent.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, undefined, "parent-session"),
		);

		const child = registerExtension();
		await child.handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, undefined, "child-session"),
		);

		// Child shuts down with quit
		await child.handlers.session_shutdown(
			{ type: "session_shutdown", reason: "quit" },
			mockCtx(undefined, undefined, "child-session"),
		);

		// Parent should still be active
		onMessage?.(
			JSON.stringify({
				type: "prompt",
				text: "hello",
				context: {
					file: new URL(import.meta.url).pathname,
					cwd: "/tmp",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);

		expect(parent.pi.sendUserMessage).toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
	});

	it("clears ownerSessionId on session switch", async () => {
		const { handlers } = registerExtension();
		await handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, undefined, "session-1"),
		);
		await handlers.session_shutdown(
			{ type: "session_shutdown", reason: "new" },
			mockCtx(undefined, undefined, "session-1"),
		);

		// Owner should be cleared — a new session can now claim ownership
		const g = globalThis as typeof globalThis & {
			__piBridgeOwnerSessionId?: string | null;
		};
		expect(g.__piBridgeOwnerSessionId).toBeNull();
	});

	it("broadcasts error event when sendUserMessage throws", async () => {
		let onMessage: ((raw: string) => void) | undefined;
		vi.mocked(start).mockImplementation(async (_path, cb) => {
			onMessage ??= cb;
			return { status: "started" };
		});

		const { handlers, pi } = registerExtension();
		pi.sendUserMessage.mockImplementation(() => {
			throw new Error("This extension ctx is stale");
		});

		await handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(undefined, undefined, "test-session"),
		);

		// broadcast is mocked — check it was called with error event
		const { broadcast } = await import("../src/socket.js");

		onMessage?.(
			JSON.stringify({
				type: "prompt",
				text: "hello",
				context: {
					file: new URL(import.meta.url).pathname,
					cwd: "/tmp",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);

		expect(broadcast).toHaveBeenCalledWith(
			expect.stringContaining('"type":"error"'),
		);
		expect(broadcast).toHaveBeenCalledWith(
			expect.stringContaining('"code":"stale_context"'),
		);
	});
});

// ---------------------------------------------------------------------------
// Edit-approval gate
// ---------------------------------------------------------------------------

import { createGate, type Gate } from "../src/approval.js";

const gateGlobal = globalThis as typeof globalThis & {
	__piBridgeGate?: Gate | null;
	__piBridgeNvimTurnActive?: boolean;
};

function installStubGate(): { gate: Gate; restore: () => void } {
	const gate = {
		requestApproval: vi.fn(),
		handleAck: vi.fn(),
		handleResponse: vi.fn(),
		handleCancel: vi.fn(),
		handleDisconnect: vi.fn(),
		reset: vi.fn(),
	} as unknown as Gate;
	const prev = gateGlobal.__piBridgeGate;
	gateGlobal.__piBridgeGate = gate;
	return { gate, restore: () => (gateGlobal.__piBridgeGate = prev ?? null) };
}

/**
 * Mark the current turn as nvim-originated so the gate's origin check
 * passes. Tests reset this flag in beforeEach via the gateGlobal.
 */
function markNvimTurnActive(): void {
	gateGlobal.__piBridgeNvimTurnActive = true;
}

const editEvent = () => ({
	type: "tool_call",
	toolCallId: "t1",
	toolName: "edit",
	input: {
		path: new URL(import.meta.url).pathname,
		edits: [{ oldText: "a", newText: "b" }],
	},
});

describe("extension — edit-approval origin gate", () => {
	it("returns undefined (allow) for non-edit/write tools", async () => {
		const { handlers } = registerExtension();
		const event = {
			type: "tool_call",
			toolCallId: "t1",
			toolName: "bash",
			input: { command: "ls" },
		};
		const result = await handlers.tool_call(event, mockCtx());
		expect(result).toBeUndefined();
	});

	it("auto-approves when !ctx.hasUI (headless)", async () => {
		markNvimTurnActive();
		const { handlers } = registerExtension();
		const ctx = mockCtx();
		ctx.hasUI = false;
		const result = await handlers.tool_call(editEvent(), ctx);
		expect(result).toBeUndefined();
	});

	it("auto-approves an edit with no meaningful preview (no edits, no file)", async () => {
		markNvimTurnActive();
		const { handlers } = registerExtension();
		const event = {
			type: "tool_call",
			toolCallId: "t1",
			toolName: "edit",
			input: {
				path: "/tmp/__definitely_does_not_exist__/ghost.ts",
				edits: [],
			},
		};
		const result = await handlers.tool_call(event, mockCtx());
		expect(result).toBeUndefined();
	});

	it("PI_BRIDGE_EDIT_APPROVAL=0 disables the gate entirely", async () => {
		const prev = process.env.PI_BRIDGE_EDIT_APPROVAL;
		process.env.PI_BRIDGE_EDIT_APPROVAL = "0";
		try {
			markNvimTurnActive();
			const { handlers } = registerExtension();
			const result = await handlers.tool_call(editEvent(), mockCtx());
			expect(result).toBeUndefined();
		} finally {
			process.env.PI_BRIDGE_EDIT_APPROVAL = prev;
		}
	});

	it("pi-typed edit: origin flag false → gate is never called, no prompt shown", async () => {
		// Default: nvimTurnActive is false (reset in beforeEach).
		const { gate, restore } = installStubGate();
		try {
			const ctx = mockCtx();
			const { handlers } = registerExtension();
			const result = await handlers.tool_call(editEvent(), ctx);
			expect(result).toBeUndefined();
			// Gate not touched at all — no request, no broadcast, no prompt.
			expect(gate.requestApproval).not.toHaveBeenCalled();
			// No prompt was rendered either.
			expect(ctx.ui.custom).not.toHaveBeenCalled();
			expect(ctx.ui.setWidget).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("nvim-originated edit: prompt shown; pi 'yes' routes through gate.handleResponse and allows", async () => {
		const { gate, restore } = installStubGate();
		try {
			markNvimTurnActive();
			// Gate parks the request — it will be settled by the pi
			// prompt's handleResponse call. The mock records the call.
			const gatePromise = new Promise<{ id: string; result: string }>(() => {
				// parked; resolve via the prompt's handleResponse call.
			});
			(gate.requestApproval as ReturnType<typeof vi.fn>).mockImplementation(
				(args: any) => {
					return gatePromise.then((r) => ({ ...r, id: args.id ?? r.id }));
				},
			);

			const ctx = mockCtx();
			const resolveCustomRef: { current: (decision: any) => void } = {
				current: () => {},
			};
			ctx.ui = {
				...ctx.ui,
				custom: vi.fn(
					() =>
						new Promise((resolve) => {
							resolveCustomRef.current = resolve;
						}),
				),
			} as unknown as typeof ctx.ui;
			const { handlers } = registerExtension();
			const toolPromise = handlers.tool_call(editEvent(), ctx);

			// Wait for the gate and prompt to be in flight.
			await Promise.resolve();
			await Promise.resolve();

			// Pi user picks "yes".
			resolveCustomRef.current("yes");

			// The pi prompt's .then fires handleResponse, then the
			// race's winner is the prompt. Wait for the tool result.
			expect(await toolPromise).toBeUndefined();
			expect(gate.handleResponse).toHaveBeenCalledWith(
				expect.stringMatching(/.+/),
				"yes",
			);
		} finally {
			restore();
		}
	});

	it("nvim answer wins the race — pi prompt is shown but ignored; tool returns nvim's decision", async () => {
		const { gate, restore } = installStubGate();
		try {
			markNvimTurnActive();
			// Gate resolves "no" immediately (simulating nvim responded first).
			(gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: "id-from-caller",
				result: "no",
			});

			// Pi prompt is parked; we never settle it. The test must NOT hang
			// because the gate's resolution wins the race.
			const resolveCustomRef: { current: (decision: any) => void } = {
				current: () => {},
			};
			const ctx = mockCtx();
			ctx.ui = {
				...ctx.ui,
				custom: vi.fn(
					() =>
						new Promise((resolve) => {
							resolveCustomRef.current = resolve;
						}),
				),
			} as unknown as typeof ctx.ui;
			const { handlers } = registerExtension();

			const result = await handlers.tool_call(editEvent(), ctx);
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("User rejected edit to"),
			});
			// The pi prompt was opened (race happened), but the user's late
			// answer is never consumed.
			expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
			expect(gate.handleResponse).not.toHaveBeenCalled();
			// Clean up the dangling prompt so the test exits.
			resolveCustomRef.current("yes");
		} finally {
			restore();
		}
	});

	it("pi Esc → block 'Edit approval cancelled' and gate.handleCancel is called", async () => {
		const { gate, restore } = installStubGate();
		try {
			markNvimTurnActive();
			// Gate parks the request — the pi prompt settles it via
			// handleCancel, which the mock records.
			const gatePromise = new Promise<{ id: string; result: string }>(() => {
				// never resolves externally; the gate mock's handleCancel
				// call doesn't propagate, so the request stays parked.
			});
			(gate.requestApproval as ReturnType<typeof vi.fn>).mockImplementation(
				(args: any) => {
					return gatePromise.then((r) => ({ ...r, id: args.id ?? r.id }));
				},
			);

			const ctx = mockCtx();
			const resolveCustomRef: { current: (decision: any) => void } = {
				current: () => {},
			};
			ctx.ui = {
				...ctx.ui,
				custom: vi.fn(
					() =>
						new Promise((resolve) => {
							resolveCustomRef.current = resolve;
						}),
				),
			} as unknown as typeof ctx.ui;
			const { handlers } = registerExtension();
			const toolPromise = handlers.tool_call(editEvent(), ctx);

			await Promise.resolve();
			// Pi user presses Esc.
			resolveCustomRef.current("cancelled");

			// Wait for the promptPromise to settle.
			const result = await toolPromise;
			expect(result).toEqual({
				block: true,
				reason: "Edit approval cancelled",
			});
			// Esc routes to handleCancel so the gate settles as cancelled
			// (per-file memory is not updated).
			expect(gate.handleCancel).toHaveBeenCalledWith(
				expect.stringMatching(/.+/),
			);
			expect(gate.handleResponse).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("RPC mode: custom returns undefined → blocked as 'Edit approval cancelled'", async () => {
		const { gate, restore } = installStubGate();
		try {
			markNvimTurnActive();
			// Gate never resolves — the rpc ui.custom returning undefined
			// is what should drive the cancellation.
			let releaseGate!: (result: { id: string; result: string }) => void;
			const gatePromise = new Promise<{ id: string; result: string }>(
				(resolve) => {
					releaseGate = resolve;
				},
			);
			(gate.requestApproval as ReturnType<typeof vi.fn>).mockImplementation(
				(args: any) => {
					return gatePromise.then((r) => ({ ...r, id: args.id ?? r.id }));
				},
			);
			const ctx = mockCtx();
			ctx.ui = {
				...ctx.ui,
				custom: vi.fn().mockResolvedValue(undefined),
			} as unknown as typeof ctx.ui;
			const { handlers } = registerExtension();
			const toolPromise = handlers.tool_call(editEvent(), ctx);
			// Let the RPC path resolve.
			await new Promise((r) => setTimeout(r, 0));
			const result = await toolPromise;
			expect(result).toEqual({
				block: true,
				reason: "Edit approval cancelled",
			});
			expect(gate.handleCancel).toHaveBeenCalledWith(
				expect.stringMatching(/.+/),
			);
			// Cleanup so the dangling gate promise resolves.
			releaseGate({ id: "ignored", result: "cancelled" });
		} finally {
			restore();
		}
	});

	it("resets the gate (and origin flag) on session_start", async () => {
		const { gate, restore } = installStubGate();
		try {
			markNvimTurnActive();
			const { handlers } = registerExtension();
			await handlers.session_start(
				{ type: "session_start", reason: "startup" },
				mockCtx(),
			);
			expect(gate.reset).toHaveBeenCalled();
			// Origin flag must be cleared by session_start (leak-proofing).
			expect(gateGlobal.__piBridgeNvimTurnActive).not.toBe(true);
		} finally {
			restore();
		}
	});
});

describe("extension — origin flag lifecycle", () => {
	it("is cleared on agent_end", async () => {
		markNvimTurnActive();
		const { handlers } = registerExtension();
		await handlers.agent_end({ messages: [] }, mockCtx());
		expect(gateGlobal.__piBridgeNvimTurnActive).not.toBe(true);
	});

	it("is cleared on session_before_switch", async () => {
		markNvimTurnActive();
		const { handlers } = registerExtension();
		await handlers.session_before_switch({});
		expect(gateGlobal.__piBridgeNvimTurnActive).not.toBe(true);
	});

	it("is cleared on session_start", async () => {
		markNvimTurnActive();
		const { handlers } = registerExtension();
		await handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(),
		);
		expect(gateGlobal.__piBridgeNvimTurnActive).not.toBe(true);
	});

	it("is cleared on session_shutdown", async () => {
		markNvimTurnActive();
		const { handlers } = registerExtension();
		await handlers.session_shutdown(
			{ type: "session_shutdown", reason: "quit" },
			mockCtx(),
		);
		expect(gateGlobal.__piBridgeNvimTurnActive).not.toBe(true);
	});

	it("is set true on inbound prompt message dispatch", async () => {
		const { handlers } = registerExtension();
		// Need a real session_start so the message callback is wired.
		let onMessage: ((raw: string) => void) | undefined;
		vi.mocked(start).mockImplementation(async (_path, cb) => {
			onMessage = cb;
			return { status: "started" };
		});
		await handlers.session_start(
			{ type: "session_start", reason: "startup" },
			mockCtx(),
		);
		expect(gateGlobal.__piBridgeNvimTurnActive).not.toBe(true);

		onMessage?.(
			JSON.stringify({
				type: "prompt",
				text: "hello",
				context: {
					file: new URL(import.meta.url).pathname,
					cwd: "/tmp",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);
		expect(gateGlobal.__piBridgeNvimTurnActive).toBe(true);
	});
});

describe("extension — approval_resolved broadcast", () => {
	it("is broadcast exactly once when the gate resolves (regardless of source)", async () => {
		const { broadcast } = await import("../src/socket.js");
		// Use a fresh broadcast mock for this test so prior tests'
		// accumulated calls don't confuse the assertions.
		const localBroadcast = vi.fn();
		const observed: string[] = [];
		const onResolved = vi.fn((id: string) => {
			observed.push(id);
			// Mirror what the real wiring does: broadcast approval_resolved.
			localBroadcast(`${JSON.stringify({ type: "approval_resolved", id })}\n`);
		});
		const gate = createGate({ broadcast: localBroadcast, onResolved });

		// Simulate a nvim-driven settlement.
		const p = gate.requestApproval({
			tool: "edit",
			path: "/tmp/x.ts",
			diff: "+x",
			signal: undefined,
		});
		// Wait for the request broadcast to happen.
		const waitForBroadcast = () =>
			new Promise<void>((resolve) => {
				const check = () => {
					if (localBroadcast.mock.calls.length > 0) {
						resolve();
					} else {
						setTimeout(check, 0);
					}
				};
				check();
			});
		await waitForBroadcast();
		const id = JSON.parse(localBroadcast.mock.calls[0][0].trim()).id;
		gate.handleResponse(id, "yes");
		expect((await p).result).toBe("yes");

		expect(observed).toEqual([id]);
		// Exactly one approval_resolved event broadcast on our local mock.
		const resolvedCalls = localBroadcast.mock.calls.filter((c) =>
			(c[0] as string).includes('"type":"approval_resolved"'),
		);
		expect(resolvedCalls).toHaveLength(1);
		// Sanity: the real (mocked) socket broadcast was NOT called by us
		// — the real wiring does that via the getGate() helper, which
		// isn't used in this test.
		expect(broadcast).not.toHaveBeenCalledWith(
			expect.stringContaining('"type":"approval_resolved"'),
		);
	});
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("extension — edit-tool system-prompt guard", () => {
	it("appends the file-editing guard to every turn's system prompt", async () => {
		const { handlers } = registerExtension();
		const event = {
			type: "before_agent_start",
			prompt: "do a thing",
			systemPrompt: "BASE PROMPT",
		};
		const result = await handlers.before_agent_start(event, mockCtx());
		expect(result).toEqual({
			systemPrompt: expect.stringMatching(/^BASE PROMPT\n\n/),
		});
		expect((result as { systemPrompt: string }).systemPrompt).toContain(
			"edit` and `write` tools",
		);
	});

	it("injects nothing when the approval gate is disabled", async () => {
		const prev = process.env.PI_BRIDGE_EDIT_APPROVAL;
		process.env.PI_BRIDGE_EDIT_APPROVAL = "0";
		try {
			const { handlers } = registerExtension();
			const result = await handlers.before_agent_start(
				{ type: "before_agent_start", prompt: "x", systemPrompt: "BASE" },
				mockCtx(),
			);
			expect(result).toBeUndefined();
		} finally {
			process.env.PI_BRIDGE_EDIT_APPROVAL = prev;
		}
	});
});
