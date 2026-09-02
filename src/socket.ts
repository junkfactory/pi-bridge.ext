/**
 * Unix socket lifecycle.
 *
 * Creates a Unix domain server, handles connections with newline-delimited
 * JSON framing, and cleans up stale sockets from previous sessions.
 */

import { createServer, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync, chmodSync } from "node:fs";
import { frameBuffer } from "./protocol.js";
import { error, info, warn } from "./log.js";

/** Max buffer size per connection (1MB). Messages exceeding this are dropped. */
const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

/** Defensive upper bound for server.close() to resolve during shutdown. */
const SHUTDOWN_TIMEOUT_MS = 1000;

/** Active server state, null when not running. */
let server: Server | null = null;
let socketPath: string | null = null;

/** Active client sockets; destroyed on shutdown to let server.close() resolve. */
const connections = new Set<Socket>();

/** True while stop() is in flight, so concurrent calls share the same promise. */
let stopping: Promise<void> | null = null;

/** Signal handlers registered once. */
let signalsRegistered = false;

/**
 * Start listening on the given socket path.
 *
 * Idempotent activation:
 * - If the socket file exists and a connection succeeds → server already
 *   running (noop, returns false).
 * - If the socket file exists but connection fails (ECONNREFUSED) → stale
 *   socket from a crashed session. Removes it and creates fresh.
 * - If no socket file → creates fresh.
 *
 * Returns true if a new server was started, false if already running.
 */
export async function start(
	path: string,
	onMessage: (data: string) => void,
): Promise<boolean> {
	if (server) {
		warn("Socket server already running", { path: socketPath });
		return false;
	}

	// Check for existing socket
	if (existsSync(path)) {
		const alive = await probeExistingSocket(path);
		if (alive) {
			info("Socket already in use by another process", { path });
			return false;
		}
		// Stale socket — remove it
		warn("Removing stale socket", { path });
		try {
			unlinkSync(path);
		} catch (err) {
			error("Failed to remove stale socket", { path, err: String(err) });
			throw err;
		}
	}

	// Create and start the server
	const srv = createServer((conn) => {
		connections.add(conn);
		conn.once("close", () => connections.delete(conn));
		handleConnection(conn, onMessage);
	});

	await new Promise<void>((resolve, reject) => {
		srv.once("error", reject);
		srv.listen(path, () => {
			// Restrict socket permissions to user-only
			try {
				chmodSync(path, 0o600);
			} catch {
				// Non-fatal on some systems
			}
			srv.removeListener("error", reject);
			resolve();
		});
	});

	server = srv;
	socketPath = path;
	info("Socket server started", { path });

	registerSignalHandlers();
	return true;
}

/**
 * Close the socket server and remove the socket file.
 *
 * Forcibly destroys any still-connected clients so server.close() does not
 * wait for them. A 1s defensive deadline resolves the wait even if a client
 * refuses to close, so Pi can always shut down deterministically.
 *
 * Safe to call repeatedly or concurrently: concurrent calls await the
 * in-flight shutdown.
 */
export async function stop(): Promise<void> {
	if (!server) return;
	if (stopping) return stopping;

	const path = socketPath;
	const srv = server;

	stopping = (async () => {
		// Destroy active clients so their close events fire and server.close()
		// is not blocked by lingering connections.
		for (const conn of connections) {
			try {
				conn.destroy();
			} catch {
				// already closed/closing — ignore
			}
		}
		connections.clear();

		// Await close with a defensive deadline.
		let deadlineFired = false;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				deadlineFired = true;
				warn(
					"Socket server close exceeded deadline; continuing shutdown",
					{ path, timeoutMs: SHUTDOWN_TIMEOUT_MS },
				);
				resolve();
			}, SHUTDOWN_TIMEOUT_MS);

			srv.close((err) => {
				if (deadlineFired) return; // deadline already resolved
				clearTimeout(timer);
				if (err) {
					warn("Server close error", { path, err: String(err) });
				}
				resolve();
			});
		});

		// Clean up socket file regardless of close outcome.
		if (path && existsSync(path)) {
			try {
				unlinkSync(path);
			} catch (err) {
				warn("Failed to remove socket file on shutdown", { path, err: String(err) });
			}
		}

		info("Socket server stopped", { path });
		server = null;
		socketPath = null;
		stopping = null;
	})();

	return stopping;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Probe whether an existing socket is alive by attempting a connection.
 * Returns true if the connection succeeds (server is alive), false if
 * ECONNREFUSED (stale socket).
 */
function probeExistingSocket(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const { createConnection } = require("node:net");
		const sock: Socket = createConnection(path);

		sock.once("connect", () => {
			sock.destroy();
			resolve(true);
		});

		sock.once("error", () => {
			sock.destroy();
			resolve(false);
		});
	});
}

/** Handle a single client connection: buffer data, split on newlines. */
function handleConnection(conn: Socket, onMessage: (data: string) => void): void {
	let buffer = "";

	conn.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();

		// Guard against oversized buffers (malicious or broken client)
		if (buffer.length > MAX_BUFFER_BYTES) {
			warn("Buffer overflow, dropping connection", { size: buffer.length });
			buffer = "";
			conn.destroy();
			return;
		}

		const { messages, remainder } = frameBuffer(buffer);
		buffer = remainder;

		for (const msg of messages) {
			try {
				onMessage(msg);
			} catch (err) {
				error("Error handling message", { err: String(err) });
			}
		}
	});

	conn.on("error", (err) => {
		warn("Connection error", { err: String(err) });
	});

	conn.on("close", () => {
		// Flush any remaining partial message
		if (buffer.trim().length > 0) {
			try {
				onMessage(buffer);
			} catch (err) {
				error("Error handling final message", { err: String(err) });
			}
			buffer = "";
		}
	});
}

/** Register SIGINT/SIGTERM handlers for graceful shutdown. */
function registerSignalHandlers(): void {
	if (signalsRegistered) return;
	signalsRegistered = true;

	const shutdown = async (signal: string) => {
		info("Received signal, shutting down", { signal });
		await stop();
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}
