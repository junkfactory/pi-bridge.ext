import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { start, stop } from "../src/socket.js";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
let sockPath: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-bridge-test-"));
	sockPath = join(tmpDir, "test.sock");
});

afterEach(async () => {
	await stop();
	rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper: connect to the socket and return the connection. */
function connect(): Promise<ReturnType<typeof createConnection>> {
	return new Promise((resolve, reject) => {
		const sock = createConnection(sockPath);
		sock.once("connect", () => resolve(sock));
		sock.once("error", reject);
	});
}

/** Helper: send data over a socket. */
function send(sock: ReturnType<typeof createConnection>, data: string): Promise<void> {
	return new Promise((resolve, reject) => {
		sock.write(data, (err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

/** Helper: wait for a condition with timeout. */
function waitFor(
	check: () => boolean,
	timeoutMs = 1000,
): Promise<void> {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("socket lifecycle", () => {
	it("starts and stops cleanly", async () => {
		const started = await start(sockPath, () => {});
		expect(started).toBe(true);
		expect(existsSync(sockPath)).toBe(true);

		await stop();
		expect(existsSync(sockPath)).toBe(false);
	});

	it("returns false if already running", async () => {
		await start(sockPath, () => {});
		const second = await start(sockPath, () => {});
		expect(second).toBe(false);
	});

	it("handles stale socket (ECONNREFUSED)", async () => {
		// Create a stale socket file (not backed by a server)
		writeFileSync(sockPath, "");

		const started = await start(sockPath, () => {});
		expect(started).toBe(true);
		expect(existsSync(sockPath)).toBe(true);
	});

	it("sets socket permissions to 600", async () => {
		const { statSync } = await import("node:fs");
		await start(sockPath, () => {});

		const stat = statSync(sockPath);
		const mode = (stat.mode & 0o777).toString(8);
		expect(mode).toBe("600");
	});
});

describe("message handling", () => {
	it("receives a complete message", async () => {
		const received: string[] = [];
		await start(sockPath, (msg) => received.push(msg));

		const sock = await connect();
		await send(sock, '{"type":"prompt","text":"hello"}\n');

		await waitFor(() => received.length === 1);
		expect(received[0]).toBe('{"type":"prompt","text":"hello"}');
		sock.destroy();
	});

	it("receives multiple messages in one chunk", async () => {
		const received: string[] = [];
		await start(sockPath, (msg) => received.push(msg));

		const sock = await connect();
		await send(sock, '{"a":1}\n{"b":2}\n{"c":3}\n');

		await waitFor(() => received.length === 3);
		expect(received).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
		sock.destroy();
	});

	it("buffers partial messages until newline", async () => {
		const received: string[] = [];
		await start(sockPath, (msg) => received.push(msg));

		const sock = await connect();
		await send(sock, '{"partial":');
		await send(sock, '"value"}\n');

		await waitFor(() => received.length === 1);
		expect(received[0]).toBe('{"partial":"value"}');
		sock.destroy();
	});

	it("flushes partial message on connection close", async () => {
		const received: string[] = [];
		await start(sockPath, (msg) => received.push(msg));

		const sock = await connect();
		await send(sock, '{"no_newline":true}');
		sock.destroy();

		await waitFor(() => received.length === 1);
		expect(received[0]).toBe('{"no_newline":true}');
	});

	it("handles multiple connections", async () => {
		const received: string[] = [];
		await start(sockPath, (msg) => received.push(msg));

		const sock1 = await connect();
		const sock2 = await connect();
		await send(sock1, '{"from":"conn1"}\n');
		await send(sock2, '{"from":"conn2"}\n');

		await waitFor(() => received.length === 2);
		expect(received).toContain('{"from":"conn1"}');
		expect(received).toContain('{"from":"conn2"}');
		sock1.destroy();
		sock2.destroy();
	});

	it("drops connection on buffer overflow", async () => {
		const received: string[] = [];
		await start(sockPath, (msg) => received.push(msg));

		const sock = await connect();
		// Send 2MB of data without a newline (exceeds 1MB limit)
		const big = "x".repeat(2 * 1024 * 1024);
		try {
			await send(sock, big);
		} catch {
			// Expected: write may fail when server destroys the connection
		}

		// Connection should be destroyed, no messages received
		await new Promise((r) => setTimeout(r, 200));
		expect(received.length).toBe(0);
	});
});
