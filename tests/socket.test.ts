import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { start, stop, broadcast } from "../src/socket.js";
import { info, warn } from "../src/log.js";
import { createConnection, createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../src/log.js", () => ({
	LOG_PATH: "/tmp/pi-bridge-test.log",
	setLogLevel: vi.fn(),
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("node:net", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:net")>();
	return {
		...actual,
		createConnection: (...args: any[]) => {
			if ((globalThis as any).__probeHangs) {
				// Real socket that never connects and never errors — simulates a
				// half-dead listener so the probe timeout path is exercised.
				return new actual.Socket();
			}
			return actual.createConnection(...(args as Parameters<typeof actual.createConnection>));
		},
	};
});

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
		expect(started).toEqual({ status: "started" });
		expect(existsSync(sockPath)).toBe(true);

		await stop();
		expect(existsSync(sockPath)).toBe(false);
	});

	it("logs lifecycle events with the process pid", async () => {
		await start(sockPath, () => {});
		expect(info).toHaveBeenCalledWith("Socket server started", { path: sockPath, pid: process.pid });

		await stop();
		expect(info).toHaveBeenCalledWith("Socket server stopped", { path: sockPath, pid: process.pid });
	});

	it("returns already-hosted if already running", async () => {
		await start(sockPath, () => {});
		const second = await start(sockPath, () => {});
		expect(second).toEqual({ status: "already-hosted" });
		expect(info).toHaveBeenCalledWith("Socket server already running", {
			path: sockPath,
			pid: process.pid,
		});
	});

	it("handles stale socket (ECONNREFUSED)", async () => {
		// Create a stale socket file (not backed by a server)
		writeFileSync(sockPath, "");

		const started = await start(sockPath, () => {});
		expect(started).toEqual({ status: "started" });
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

describe("broadcast", () => {
	it("sends data to multiple clients", async () => {
		await start(sockPath, () => {});

		const sock1 = await connect();
		const sock2 = await connect();

		// Both clients should receive the data
		const received1: string[] = [];
		const received2: string[] = [];
		sock1.on("data", (chunk) => received1.push(chunk.toString()));
		sock2.on("data", (chunk) => received2.push(chunk.toString()));

		const data = '{"type":"agent_start","message":"working..."}\n';
		broadcast(data);

		await waitFor(() => received1.length > 0 && received2.length > 0);
		expect(received1[0]).toBe(data);
		expect(received2[0]).toBe(data);

		sock1.destroy();
		sock2.destroy();
	});

	it("skips destroyed clients", async () => {
		await start(sockPath, () => {});

		const sock1 = await connect();
		const sock2 = await connect();

			// Destroy sock1 before broadcasting
			sock1.destroy();
			await waitFor(() => sock1.destroyed);

		const data = '{"type":"agent_end","message":"done"}\n';

		const received2: string[] = [];
			sock2.on("data", (chunk) => received2.push(chunk.toString()));

			broadcast(data);

			await waitFor(() => received2.length > 0);
			expect(received2[0]).toBe(data);

			sock2.destroy();
	});

	it("is a noop with no connections", () => {
		// Should not throw when there are no connections
		expect(() => broadcast('{"type":"test"}\n')).not.toThrow();
	});
});

describe("probe timeout", () => {
	beforeEach(() => {
		(globalThis as any).__probeHangs = false;
	});

	afterEach(() => {
		(globalThis as any).__probeHangs = false;
	});

	it("resolves false when the probe exceeds 500ms", async () => {
		// Regular file at the socket path + a hanging probe connection.
		writeFileSync(sockPath, "");

		(globalThis as any).__probeHangs = true;
		const t0 = Date.now();
		try {
			// Probe timeout resolves false → socket treated as stale → rebound.
			const result = await start(sockPath, () => {});
			const elapsed = Date.now() - t0;
			expect(result).toEqual({ status: "started" });
			expect(existsSync(sockPath)).toBe(true);
			// Must have waited for the 500ms timeout, not failed fast.
			expect(elapsed).toBeGreaterThanOrEqual(450);
			expect(elapsed).toBeLessThan(1500);
		} finally {
			(globalThis as any).__probeHangs = false;
		}
	});

	it("still detects a stale socket via ECONNREFUSED", async () => {
		writeFileSync(sockPath, "");

		const result = await start(sockPath, () => {});
		expect(result).toEqual({ status: "started" });
	});
});

describe("shared state across module reloads", () => {
	it("fresh module evaluation adopts the live singleton server", async () => {
		const first = await start(sockPath, () => {});
		expect(first).toEqual({ status: "started" });

		// Re-evaluate the module; it must see the same live server.
		vi.resetModules();
		const fresh = await import("../src/socket.js");

		const second = await fresh.start(sockPath, () => {});
		expect(second).toEqual({ status: "already-hosted" } as any);

		// The singleton server still serves connections.
		const sock = await connect();
		sock.destroy();

		// A stop through the fresh module tears the shared server down.
		await fresh.stop();
		expect(existsSync(sockPath)).toBe(false);
	});
});

describe("shutdown with active clients", () => {
	it("stops within the deadline when a client is still connected", async () => {
		await start(sockPath, () => {});

		// Connect a client but don't close it before shutdown — this is the
		// regression scenario: server.close() would otherwise wait forever
		// for the client to disconnect.
		const sock = await connect();

		const stopPromise = stop();

		// 1s shutdown deadline + 500ms safety margin
		await Promise.race([
			stopPromise,
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error("stop() exceeded deadline")), 1500),
			),
		]);

		expect(existsSync(sockPath)).toBe(false);

		// Client must observe the close
		await waitFor(() => sock.destroyed, 1000);
		expect(sock.destroyed).toBe(true);
	});

	it("stops when multiple clients are still connected", async () => {
		await start(sockPath, () => {});

		const sock1 = await connect();
		const sock2 = await connect();
		const sock3 = await connect();

		const stopPromise = stop();
		await Promise.race([
			stopPromise,
			new Promise<void>((_, reject) =>
				setTimeout(() => reject(new Error("stop() exceeded deadline")), 1500),
			),
		]);

		expect(existsSync(sockPath)).toBe(false);

		await waitFor(() => sock1.destroyed && sock2.destroyed && sock3.destroyed, 1000);
		expect(sock1.destroyed).toBe(true);
		expect(sock2.destroyed).toBe(true);
		expect(sock3.destroyed).toBe(true);
	});

	it("stop() is idempotent and safe to call concurrently", async () => {
		await start(sockPath, () => {});
		await connect();

		// Fire multiple concurrent stops; none should throw or hang.
		const results = await Promise.all([
			stop(),
			stop(),
			stop(),
		]);

		expect(results.every((r) => r === undefined)).toBe(true);
		expect(existsSync(sockPath)).toBe(false);

		// A subsequent start() must succeed (state fully reset).
		const restarted = await start(sockPath, () => {});
		expect(restarted).toEqual({ status: "started" });
	});

	it("stop() with no clients still removes the socket file", async () => {
		await start(sockPath, () => {});
		expect(existsSync(sockPath)).toBe(true);

		await stop();
		expect(existsSync(sockPath)).toBe(false);
	});

	it("leaves the socket file in place when the inode no longer matches", async () => {
		await start(sockPath, () => {}); // server A binds the file
		const inodeA = statSync(sockPath).ino;

		// Simulate a newer session taking over the path: rebind a new server B.
		// Burn the freed inode first — APFS reuses it immediately, which would
		// give B's file the same inode as A's and make the test meaningless.
		const filler = join(tmpDir, "filler");
		writeFileSync(filler, "");
		unlinkSync(sockPath);

		const serverB = createServer(() => {});
		await new Promise<void>((resolve) => serverB.listen(sockPath, resolve));
		try {
			const inodeB = statSync(sockPath).ino;
			expect(inodeB).not.toBe(inodeA);

			await stop(); // server A shuts down — must NOT unlink B's file

			expect(existsSync(sockPath)).toBe(true);
			expect(info).toHaveBeenCalledWith(
				"Socket file owned by newer session; leaving in place",
				{ path: sockPath, pid: process.pid },
			);

			// B still serves connections.
			const sock = await connect();
			sock.destroy();
		} finally {
			await new Promise<void>((resolve) => serverB.close(() => resolve()));
			try {
				unlinkSync(sockPath);
				rmSync(filler, { force: true });
			} catch {
				// leftover from a failure above
			}
		}
	});
});
