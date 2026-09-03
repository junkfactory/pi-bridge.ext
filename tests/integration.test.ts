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
			},
		}) + "\n";
		await send(sock, msg);
		sock.destroy();

		// Verify pi received the raw text exactly
		await waitFor(() => pi.sendUserMessage.mock.calls.length === 1);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();

		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toBe("add error handling");
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
			},
		}) + "\n";
		await send(sock, msg);
		sock.destroy();

		await waitFor(() => pi.sendUserMessage.mock.calls.length === 1);
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toBe("explain this");
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

describe("integration: agent_start and agent_end hooks", () => {
	it("agent_start broadcasts to connected clients", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		// Simulate pi firing agent_start
		mockPi.handlers["agent_start"]({}, { cwd: "/project" });

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({ type: "agent_start", message: "working..." });
		sock.destroy();
	});

	it("agent_end broadcasts to connected clients", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		// Simulate pi firing agent_end
		mockPi.handlers["agent_end"]({}, { cwd: "/project" });

		await waitFor(() => received.length === 1);
		const msg = JSON.parse(received[0].trim());
		expect(msg).toEqual({ type: "agent_end", message: "done" });
		sock.destroy();
	});

	it("agent_start and agent_end both fire in sequence", async () => {
		await start(sockPath, () => {});

		const mockPi = createMockPi();
		index(mockPi);

		const sock = await connect();
		const received: string[] = [];
		sock.on("data", (chunk) => received.push(chunk.toString()));

		mockPi.handlers["agent_start"]({}, { cwd: "/project" });
		await waitFor(() => received.length === 1);

		mockPi.handlers["agent_end"]({}, { cwd: "/project" });
		await waitFor(() => received.length === 2);

		const startMsg = JSON.parse(received[0].trim());
		const endMsg = JSON.parse(received[1].trim());
		expect(startMsg).toEqual({ type: "agent_start", message: "working..." });
		expect(endMsg).toEqual({ type: "agent_end", message: "done" });
		sock.destroy();
	});
});
