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
	};
	g.__piBridgeOwnerSessionId = null;
	g.__piBridgePiMap = new Map();
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

import type { Gate } from "../src/approval.js";

const gateGlobal = globalThis as typeof globalThis & {
	__piBridgeGate?: Gate | null;
};

function installStubGate(): { gate: Gate; restore: () => void } {
	const gate = {
		requestApproval: vi.fn(),
		handleAck: vi.fn(),
		handleResponse: vi.fn(),
		settle: vi.fn(),
		handleDisconnect: vi.fn(),
		reset: vi.fn(),
	} as unknown as Gate;
	const prev = gateGlobal.__piBridgeGate;
	gateGlobal.__piBridgeGate = gate;
	return { gate, restore: () => (gateGlobal.__piBridgeGate = prev ?? null) };
}

describe("extension — edit-approval gate", () => {
	it("auto-approves when !ctx.hasUI (headless)", async () => {
		const { handlers } = registerExtension();
		const ctx = mockCtx();
		ctx.hasUI = false;
		const event = {
			type: "tool_call",
			toolCallId: "t1",
			toolName: "edit",
			input: { path: "/tmp/x.ts", edits: [{ oldText: "a", newText: "b" }] },
		};
		const result = await handlers.tool_call(event, ctx);
		expect(result).toBeUndefined();
	});

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

	it("auto-approves an edit with no meaningful preview (no edits, no file)", async () => {
		const { handlers } = registerExtension();
		// Path that doesn't exist + empty edits → buildDiff returns null → no preview → allow
		const event = {
			type: "tool_call",
			toolCallId: "t1",
			toolName: "edit",
			input: { path: "/tmp/__definitely_does_not_exist__/ghost.ts", edits: [] },
		};
		const result = await handlers.tool_call(event, mockCtx());
		expect(result).toBeUndefined();
	});

	it("PI_BRIDGE_EDIT_APPROVAL=0 disables the gate entirely", async () => {
		const prev = process.env.PI_BRIDGE_EDIT_APPROVAL;
		process.env.PI_BRIDGE_EDIT_APPROVAL = "0";
		try {
			const { handlers } = registerExtension();
			const event = {
				type: "tool_call",
				toolCallId: "t1",
				toolName: "edit",
				input: {
					path: new URL(import.meta.url).pathname,
					edits: [{ oldText: "a", newText: "b" }],
				},
			};
			const result = await handlers.tool_call(event, mockCtx());
			expect(result).toBeUndefined();
		} finally {
			process.env.PI_BRIDGE_EDIT_APPROVAL = prev;
		}
	});

	it("blocks with a reason when the gate resolves to 'no'", async () => {
		const { gate, restore } = installStubGate();
		try {
			(gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: "req-1",
				result: "no",
			});
			const { handlers } = registerExtension();
			const event = {
				type: "tool_call",
				toolCallId: "t1",
				toolName: "edit",
				input: {
					path: new URL(import.meta.url).pathname,
					edits: [{ oldText: "a", newText: "b" }],
				},
			};
			const result = await handlers.tool_call(event, mockCtx());
			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining("User rejected edit to"),
			});
		} finally {
			restore();
		}
	});

	it("blocks with 'Edit approval cancelled' when the gate resolves to 'cancelled'", async () => {
		const { gate, restore } = installStubGate();
		try {
			(gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: "req-1",
				result: "cancelled",
			});
			const { handlers } = registerExtension();
			const event = {
				type: "tool_call",
				toolCallId: "t1",
				toolName: "edit",
				input: {
					path: new URL(import.meta.url).pathname,
					edits: [{ oldText: "a", newText: "b" }],
				},
			};
			const result = await handlers.tool_call(event, mockCtx());
			expect(result).toEqual({
				block: true,
				reason: "Edit approval cancelled",
			});
		} finally {
			restore();
		}
	});

	it("calls gate.settle on the fallback path with the overlay decision", async () => {
		const { gate, restore } = installStubGate();
		// The mock ctx must expose ui.custom that resolves with a decision.
		const mockCtxWithOverlay = () => {
			const ctx = mockCtx();
			ctx.ui = {
				...ctx.ui,
				custom: vi.fn().mockResolvedValue("yes"),
				setWidget: vi.fn(),
			} as unknown as typeof ctx.ui;
			return ctx;
		};
		try {
			(gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: "req-1",
				result: "fallback",
			});
			const { handlers } = registerExtension();
			const event = {
				type: "tool_call",
				toolCallId: "t1",
				toolName: "edit",
				input: {
					path: new URL(import.meta.url).pathname,
					edits: [{ oldText: "a", newText: "b" }],
				},
			};
			const result = await handlers.tool_call(event, mockCtxWithOverlay());
			expect(gate.settle).toHaveBeenCalledWith(
				"req-1",
				"yes",
				expect.stringContaining("index.test.ts"),
			);
			expect(result).toBeUndefined();
		} finally {
			restore();
		}
	});

	it("blocks as cancelled when the fallback overlay cannot run (RPC mode returns undefined)", async () => {
		const { gate, restore } = installStubGate();
		const ctxRpcOverlay = () => {
			const ctx = mockCtx();
			ctx.ui = {
				...ctx.ui,
				custom: vi.fn().mockResolvedValue(undefined),
				setWidget: vi.fn(),
			} as unknown as typeof ctx.ui;
			return ctx;
		};
		try {
			(gate.requestApproval as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: "req-1",
				result: "fallback",
			});
			const { handlers } = registerExtension();
			const event = {
				type: "tool_call",
				toolCallId: "t1",
				toolName: "edit",
				input: {
					path: new URL(import.meta.url).pathname,
					edits: [{ oldText: "a", newText: "b" }],
				},
			};
			const result = await handlers.tool_call(event, ctxRpcOverlay());
			expect(result).toEqual({
				block: true,
				reason: "Edit approval cancelled",
			});
			// No decision was made, so per-file memory must not be updated.
			expect(gate.settle).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("resets the gate on session_start", async () => {
		const { gate, restore } = installStubGate();
		try {
			const { handlers } = registerExtension();
			await handlers.session_start(
				{ type: "session_start", reason: "startup" },
				mockCtx(),
			);
			expect(gate.reset).toHaveBeenCalled();
		} finally {
			restore();
		}
	});
});

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
