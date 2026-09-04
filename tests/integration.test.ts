/**
 * Integration test: full flow from socket message to pi.sendUserMessage().
 *
 * Starts the socket server, sends a prompt message through a real
 * Unix socket connection, and verifies the pi API receives the
 * correctly formatted user message.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { start, stop, broadcast } from "../src/socket.js";
import { parseMessage } from "../src/protocol.js";
import { handleMessage } from "../src/handler.js";
import index from "../src/index.js";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

let tmpDir: string;
let sockPath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-bridge-integration-"));
	sockPath = join(tmpDir, "test.sock");
});

afterEach(async () => {
	await stop();
	rmSync(tmpDir, { recursive: true, force: true });
});

function connect(): Promise<ReturnType<typeof createConnection>> {
	return new Promise((resolve, reject) => {
		const sock = createConnection(sockPath);
		sock.once("connect", () => resolve(sock));
		sock.once("error", reject);
	});
}

function send(sock: ReturnType<typeof createConnection>, data: string): Promise<void> {
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
			if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
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
		const msg = JSON.stringify({
			type: "prompt",
			text: "add error handling",
			context: {
				file: "/home/user/src/main.ts",
				cwd: "/home/user",
				mode: "normal",
				buffer_state: "saved",
			},
		}) + "\n";
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
		const msg = JSON.stringify({
			type: "prompt",
			text: "explain this",
			context: {
				file: "/home/user/src/utils.ts",
				cwd: "/home/user",
				mode: "visual",
				buffer_state: "saved",
			},
		}) + "\n";
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
		await send(sock, 'not json\n');
		sock.destroy();

		await new Promise((r) => setTimeout(r, 200));
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Mock ExtensionAPI for testing agent_start / agent_end hooks from index.ts
// ---------------------------------------------------------------------------

function createMockPi(): ExtensionAPI & { handlers: Record<string, Function> } {
	const handlers: Record<string, Function> = {};
	return {
		on(event: string, handler: Function) {
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
			getContextUsage: () => ({ tokens: 50000, contextWindow: 200000, percent: 25 }),
		});

		mockPi.handlers["agent_start"]({}, ctx);

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

		mockPi.handlers["agent_start"]({}, ctx);

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

		mockPi.handlers["agent_start"]({}, ctx);

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({ type: "agent_start", message: "claude-haiku is thinking" });
		sock.destroy();
	});

	it("agent_start falls back to 'agent' when model is undefined", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		mockPi.handlers["agent_start"]({}, makeMockCtx());

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

		mockPi.handlers["agent_end"]({ messages: [] }, makeMockCtx());

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

		mockPi.handlers["agent_end"](event, makeMockCtx());

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

		mockPi.handlers["agent_end"](event, makeMockCtx());

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

		mockPi.handlers["agent_end"](event, makeMockCtx());

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
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					timestamp: 0,
				},
			],
		};

		mockPi.handlers["agent_end"](event, makeMockCtx());

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

		const ctx = makeMockCtx({ model: { id: "claude-opus-4", name: "Claude Opus 4" } });

		mockPi.handlers["agent_start"]({}, ctx);
		await waitFor(() => received.length === 1);

		mockPi.handlers["agent_end"]({ messages: [] }, ctx);
		await waitFor(() => received.length === 2);

		const startMsg = JSON.parse(received[0].trim());
		const endMsg = JSON.parse(received[1].trim());
		expect(startMsg).toEqual({ type: "agent_start", message: "Claude Opus 4 is thinking" });
		expect(endMsg).toEqual({ type: "agent_end", message: "done" });
		sock.destroy();
	});
});
