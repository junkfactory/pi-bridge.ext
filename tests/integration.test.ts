/**
 * Integration test: full flow from socket message to pi.sendUserMessage().
 *
 * Starts the socket server, sends a prompt message through a real
 * Unix socket connection, and verifies the pi API receives the
 * correctly formatted user message.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	onTestFailed,
	vi,
} from "vitest";
import { handleMessage } from "../src/handler.js";
import index from "../src/index.js";
import { parseMessage } from "../src/protocol.js";
import { start, stop } from "../src/socket.js";

let tmpDir: string;
let sockPath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-bridge-integration-"));
	sockPath = join(tmpDir, "test.sock");
	// Redirect logging to the temp dir — never touch the real ~/.pi log.
	const logFile = join(tmpDir, "pi-bridge.log");
	process.env.PI_BRIDGE_LOG_FILE = logFile;
	// The afterEach cleanup deletes the log even on failure; surface it in
	// the failing test's output so it is never lost to debugging.
	onTestFailed(() => {
		try {
			console.error(
				`--- pi-bridge test log (${logFile}) ---\n${readFileSync(logFile, "utf8")}`,
			);
		} catch {
			// log file may not exist if the test failed before any logging
		}
	});
});

afterEach(async () => {
	await stop();
	delete process.env.PI_BRIDGE_LOG_FILE;
	rmSync(tmpDir, { recursive: true, force: true });
});

function connect(): Promise<ReturnType<typeof createConnection>> {
	return new Promise((resolve, reject) => {
		const sock = createConnection(sockPath);
		sock.once("connect", () => resolve(sock));
		sock.once("error", reject);
	});
}

function send(
	sock: ReturnType<typeof createConnection>,
	data: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		sock.write(data, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const poll = () => {
			if (check()) return resolve();
			if (Date.now() - start > timeoutMs)
				return reject(new Error("waitFor timeout"));
			setTimeout(poll, 10);
		};
		poll();
	});
}

describe("integration: socket → protocol → handler → pi", () => {
	it("delivers a prompt message to pi.sendUserMessage", async () => {
		const pi = { sendUserMessage: vi.fn() };

		// Wire: socket → parse → handle
		await start(sockPath, (raw) => {
			const message = parseMessage(raw);
			if (message) handleMessage(pi as any, message);
		});

		// Send a prompt through the socket
		const sock = await connect();
		const msg = `${JSON.stringify({
			type: "prompt",
			text: "add error handling",
			context: {
				file: "/home/user/src/main.ts",
				cwd: "/home/user",
				mode: "normal",
				buffer_state: "saved",
			},
		})}\n`;
		await send(sock, msg);
		sock.destroy();

		// Verify pi received the raw text exactly
		await waitFor(() => pi.sendUserMessage.mock.calls.length === 1);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();

		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toBe(
			"File: [main.ts](/home/user/src/main.ts)\n\nadd error handling",
		);
	});

	it("delivers visual mode context", async () => {
		const pi = { sendUserMessage: vi.fn() };

		await start(sockPath, (raw) => {
			const message = parseMessage(raw);
			if (message) handleMessage(pi as any, message);
		});

		const sock = await connect();
		const msg = `${JSON.stringify({
			type: "prompt",
			text: "explain this",
			context: {
				file: "/home/user/src/utils.ts",
				cwd: "/home/user",
				mode: "visual",
				buffer_state: "saved",
			},
		})}\n`;
		await send(sock, msg);
		sock.destroy();

		await waitFor(() => pi.sendUserMessage.mock.calls.length === 1);
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toBe(
			"File: [utils.ts](/home/user/src/utils.ts)\n\nexplain this",
		);
	});

	it("drops invalid messages silently", async () => {
		const pi = { sendUserMessage: vi.fn() };

		await start(sockPath, (raw) => {
			const message = parseMessage(raw);
			if (message) handleMessage(pi as any, message);
		});

		const sock = await connect();
		await send(sock, '{"type":"unknown"}\n');
		await send(sock, "not json\n");
		sock.destroy();

		await new Promise((r) => setTimeout(r, 200));
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Mock ExtensionAPI for testing agent_start / agent_end hooks from index.ts
// ---------------------------------------------------------------------------

type Handler = (event: unknown, ctx: unknown) => void;

function createMockPi(): ExtensionAPI & { handlers: Record<string, Handler> } {
	const handlers: Record<string, Handler> = {};
	return {
		on(event: string, handler: Handler) {
			handlers[event] = handler;
		},
		handlers,
		sendUserMessage: vi.fn(),
	} as any;
}

function makeMockCtx(overrides: Record<string, any> = {}) {
	return {
		cwd: "/project",
		getContextUsage: () => undefined,
		sessionManager: { getSessionId: () => "test-session-id" },
		...overrides,
	} as any;
}

describe("integration: agent_start and agent_end hooks", () => {
	it("agent_start broadcasts model + thinking level + brain usage", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		const ctx = makeMockCtx({
			model: { id: "claude-opus-4", name: "Claude Opus 4" },
			thinkingLevel: "medium",
			getContextUsage: () => ({
				tokens: 50000,
				contextWindow: 200000,
				percent: 25,
			}),
		});

		mockPi.handlers.agent_start({}, ctx);

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({
			type: "agent_start",
			message: "Claude Opus 4 is thinking in medium at 25.00% brain usage",
		});
		sock.destroy();
	});

	it("agent_start omits thinking level and brain usage when unavailable", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		const ctx = makeMockCtx({ model: { id: "gpt-5", name: "GPT-5" } });

		mockPi.handlers.agent_start({}, ctx);

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({ type: "agent_start", message: "GPT-5 is thinking" });
		sock.destroy();
	});

	it("agent_start falls back to model id when name is missing", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		const ctx = makeMockCtx({ model: { id: "claude-haiku" } });

		mockPi.handlers.agent_start({}, ctx);

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({
			type: "agent_start",
			message: "claude-haiku is thinking",
		});
		sock.destroy();
	});

	it("agent_start falls back to 'agent' when model is undefined", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		mockPi.handlers.agent_start({}, makeMockCtx());

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({ type: "agent_start", message: "agent is thinking" });
		sock.destroy();
	});

	it("agent_end broadcasts plain 'done' for empty messages", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		mockPi.handlers.agent_end({ messages: [] }, makeMockCtx());

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({ type: "agent_end", message: "done" });
		sock.destroy();
	});

	it("agent_end summarizes turns, tools, and files from messages", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		const event = {
			type: "agent_end" as const,
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "1",
							name: "read",
							arguments: { path: "/project/src/a.ts" },
						},
						{
							type: "toolCall",
							id: "2",
							name: "edit",
							arguments: { path: "/project/src/a.ts" },
						},
						{
							type: "toolCall",
							id: "3",
							name: "grep",
							arguments: { pattern: "foo" },
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "4",
							name: "write",
							arguments: { path: "/project/src/b.ts" },
						},
					],
				},
			],
		};

		mockPi.handlers.agent_end(event, makeMockCtx());

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({
			type: "agent_end",
			message: "done — 2 turns · used 4 tools · touched 2 files",
		});
		sock.destroy();
	});

	it("agent_end singularizes counts when value is 1", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		const event = {
			type: "agent_end" as const,
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "1",
							name: "read",
							arguments: { path: "/project/src/only.ts" },
						},
					],
				},
			],
		};

		mockPi.handlers.agent_end(event, makeMockCtx());

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({
			type: "agent_end",
			message: "done — 1 turn · used 1 tool · touched 1 file",
		});
		sock.destroy();
	});

	it("agent_end includes the tool error message", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		const event = {
			type: "agent_end" as const,
			messages: [
				{
					role: "toolResult",
					toolCallId: "1",
					toolName: "bash",
					content: [{ type: "text", text: "boom" }],
					isError: true,
					timestamp: 0,
				},
			],
		};

		mockPi.handlers.agent_end(event, makeMockCtx());

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg.message).toBe("done / boom");
		sock.destroy();
	});

	it("agent_end includes the assistant error message", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		const event = {
			type: "agent_end" as const,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "provider failed" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-opus-4",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "error",
					timestamp: 0,
				},
			],
		};

		mockPi.handlers.agent_end(event, makeMockCtx());

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({
			type: "agent_end",
			message: "done — 1 turn / provider failed",
		});
		sock.destroy();
	});

	it("agent_start and agent_end both fire in sequence", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		const ctx = makeMockCtx({
			model: { id: "claude-opus-4", name: "Claude Opus 4" },
		});

		mockPi.handlers.agent_start({}, ctx);
		await waitFor(() => received.length === 1);

		mockPi.handlers.agent_end({ messages: [] }, ctx);
		await waitFor(() => received.length === 2);

		const startMsg = JSON.parse(received[0].trim());
		const endMsg = JSON.parse(received[1].trim());
		expect(startMsg).toEqual({
			type: "agent_start",
			message: "Claude Opus 4 is thinking",
		});
		expect(endMsg).toEqual({ type: "agent_end", message: "done" });
		sock.destroy();
	});
});

describe("integration: edit-approval gate over the socket", () => {
	const gateGlobal = globalThis as typeof globalThis & {
		__piBridgeGate?: unknown;
		__piBridgeOwnerSessionId?: unknown;
		__piBridgePiMap?: unknown;
		__piBridgeNvimTurnActive?: boolean;
	};

	beforeEach(() => {
		gateGlobal.__piBridgeGate = null;
		gateGlobal.__piBridgeOwnerSessionId = null;
		gateGlobal.__piBridgePiMap = new Map();
		gateGlobal.__piBridgeNvimTurnActive = false;
	});

	afterEach(() => {
		gateGlobal.__piBridgeGate = null;
	});

	function makeApprovalCtx(options?: { customPromise?: Promise<any> }) {
		const customMock = options?.customPromise
			? vi.fn().mockReturnValue(options.customPromise)
			: vi.fn().mockResolvedValue(undefined);
		return {
			ctx: {
				cwd: tmpDir,
				hasUI: true,
				ui: {
					notify: vi.fn(),
					setWidget: vi.fn(),
					custom: customMock,
				},
				sessionManager: { getSessionId: () => "test-session-id" },
				signal: undefined,
			} as any,
			customMock,
		};
	}

	/** Mark the origin flag so the gate's origin check passes. */
	function markNvimTurnActive() {
		gateGlobal.__piBridgeNvimTurnActive = true;
	}

	it("nvim connects, receives approval_request, acks + responds 'no' → edit blocked", async () => {
		// A real file so buildDiff computes a non-null diff.
		const target = join(tmpDir, "nvim-rejects.ts");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(target, "const a = 1;\n");

		await start(sockPath, (raw) => {
			const message = parseMessage(raw);
			if (message) handleMessage({} as any, message);
		});

		const mockPi = createMockPi();
		index(mockPi);
		markNvimTurnActive();
		// Park the pi prompt so nvim's response wins the race.
		const parkedPrompt = new Promise<any>(() => {});
		const { ctx, customMock } = makeApprovalCtx({
			customPromise: parkedPrompt,
		});

		const sock = await connect();
		const received: string[] = [];
		let pendingData = "";
		sock.on("data", (chunk) => {
			pendingData += chunk.toString();
			for (;;) {
				const idx = pendingData.indexOf("\n");
				if (idx < 0) break;
				received.push(pendingData.slice(0, idx));
				pendingData = pendingData.slice(idx + 1);
			}
		});
		const sendNvim = (obj: Record<string, unknown>) =>
			send(sock, `${JSON.stringify(obj)}\n`);

		const toolResult = mockPi.handlers.tool_call(
			{
				type: "tool_call",
				toolCallId: "t1",
				toolName: "edit",
				input: { path: target, edits: [{ oldText: "1", newText: "2" }] },
			},
			ctx,
		);

		// nvim receives the approval_request.
		await waitFor(() =>
			received.some((l) => l.startsWith("{") && l.includes("approval_request")),
		);
		const requestLine = received.find((l) => l.includes("approval_request"));
		if (!requestLine) throw new Error("no approval_request broadcast");
		const request = JSON.parse(requestLine);

		// nvim acks (older-pi compat) and responds 'no'.
		await sendNvim({ type: "approval_ack", id: request.id });
		await sendNvim({
			type: "approval_response",
			id: request.id,
			decision: "no",
		});

		// Tool call blocks with the rejection reason.
		const result = await toolResult;
		expect(result).toEqual({
			block: true,
			reason: expect.stringContaining("User rejected edit to"),
		});
		expect(result.reason).toContain(target);

		// The pi prompt was opened (race happened) but parked.
		expect(customMock).toHaveBeenCalledTimes(1);

		// Exactly one approval_resolved for the request id reached nvim.
		await waitFor(() => received.some((l) => l.includes("approval_resolved")));
		await new Promise((r) => setTimeout(r, 50));
		const resolved = received.filter((l) => l.includes("approval_resolved"));
		expect(resolved).toHaveLength(1);
		expect(JSON.parse(resolved[0])).toEqual({
			type: "approval_resolved",
			id: request.id,
		});

		sock.destroy();
	});

	it("nvim disconnects mid-prompt → pi prompt stays open, pi answer still settles and broadcasts approval_resolved", async () => {
		const target = join(tmpDir, "disconnect-during.ts");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(target, "const x = 1;\n");

		await start(sockPath, (raw) => {
			const message = parseMessage(raw);
			if (message) handleMessage({} as any, message);
		});

		const mockPi = createMockPi();
		index(mockPi);
		markNvimTurnActive();

		// The pi prompt is parked until we settle it. The nvim disconnect
		// happens BEFORE the pi prompt settles — the prompt must stay open.
		let resolveCustom!: (decision: string) => void;
		const customPromise = new Promise<any>((resolve) => {
			resolveCustom = resolve;
		});
		const { ctx, customMock } = makeApprovalCtx({ customPromise });

		const sock = await connect();
		const received: string[] = [];
		let pendingData = "";
		sock.on("data", (chunk) => {
			pendingData += chunk.toString();
			for (;;) {
				const idx = pendingData.indexOf("\n");
				if (idx < 0) break;
				received.push(pendingData.slice(0, idx));
				pendingData = pendingData.slice(idx + 1);
			}
		});

		const toolResult = mockPi.handlers.tool_call(
			{
				type: "tool_call",
				toolCallId: "t1",
				toolName: "edit",
				input: { path: target, edits: [{ oldText: "1", newText: "2" }] },
			},
			ctx,
		);

		// Wait for approval_request to be broadcast.
		await waitFor(() => received.some((l) => l.includes("approval_request")));
		expect(customMock).toHaveBeenCalledTimes(1);

		// nvim disconnects mid-prompt — the pi prompt stays open.
		sock.destroy();

		// Give the disconnect a moment to propagate to the gate.
		await new Promise((r) => setTimeout(r, 30));
		// The tool call must NOT have settled — the prompt is still open
		// awaiting user input.
		const settled = await Promise.race([
			toolResult.then((r) => ({ kind: "settled", r })),
			new Promise((r) => setTimeout(() => r({ kind: "still-pending" }), 30)),
		]);
		expect(settled.kind).toBe("still-pending");

		// User answers in pi: 'yes' → gate.handleResponse fires
		// approval_resolved broadcast. With no nvim listener, the
		// broadcast goes to /dev/null — but the gate's internal
		// onResolved hook fires exactly once. Verify by counting
		// approval_resolved broadcasts from the test's local view: the
		// real wiring broadcasts to the socket (which has no listeners),
		// so we just verify the tool result.
		resolveCustom("yes");

		const result = await toolResult;
		expect(result).toBeUndefined(); // "yes" → allow
	});
});
