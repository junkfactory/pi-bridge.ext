/**
 * Unix socket lifecycle.
 *
 * Creates a Unix domain server, handles connections with newline-delimited
 * JSON framing, and cleans up stale sockets from previous sessions.
 *
 * All mutable server state lives in a `globalThis` singleton so that a jiti
 * module re-evaluation (extension reload / session switch) adopts the live
 * server instead of losing it.
 */

import {
	chmodSync,
	existsSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { debug, error, info, warn } from "./log.js";
import { frameBuffer } from "./protocol.js";

/** Max buffer size per connection (1MB). Messages exceeding this are dropped. */
const MAX_BUFFER_BYTES = 1 * 1024 * 1024;

/** Defensive upper bound for server.close() to resolve during shutdown. */
const SHUTDOWN_TIMEOUT_MS = 1000;

/** How long to wait for a probe connection before treating the socket as dead. */
const PROBE_TIMEOUT_MS = 500;

/** Result of start(): describes what happened on the ownership path. */
export type StartResult =
	| { status: "started" }
	| { status: "already-hosted" }
	| { status: "foreign-owner" }
	| { status: "skipped" };

/** Mutable socket server state, shared across module re-evaluations. */
interface SocketState {
	server: Server | null;
	socketPath: string | null;
	connections: Set<Socket>;
	stopping: Promise<void> | null;
	/** Inode of the socket file at bind time; null when unknown. */
	bindInode: number | null;
	signalsRegistered: boolean;
}

const globalScope = globalThis as typeof globalThis & {
	__piBridgeSocket?: SocketState;
};

/** Shared singleton state (survives jiti module reloads within one process). */
if (!globalScope.__piBridgeSocket) {
	globalScope.__piBridgeSocket = {
		server: null,
		socketPath: null,
		connections: new Set<Socket>(),
		stopping: null,
		bindInode: null,
		signalsRegistered: false,
	};
}
const state: SocketState = globalScope.__piBridgeSocket;

/**
 * Start listening on the given socket path.
 *
 * Idempotent activation:
 * - If our singleton server is already running → already-hosted (noop).
 * - If the socket file exists and a connection succeeds → another pi
 *   instance owns it (foreign-owner).
 * - If the socket file exists but connection fails (ECONNREFUSED) → stale
 *   socket from a crashed session. Removes it and creates fresh.
 * - If no socket file → creates fresh.
 */
export async function start(
	path: string,
	onMessage: (data: string) => void,
): Promise<StartResult> {
	if (state.server) {
		info("Socket server already running", {
			path: state.socketPath,
			pid: process.pid,
		});
		return { status: "already-hosted" };
	}

	// Check for existing socket
	if (existsSync(path)) {
		const alive = await probeExistingSocket(path);
		if (alive) {
			info("Socket already in use by another process", {
				path,
				pid: process.pid,
			});
			return { status: "foreign-owner" };
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
		state.connections.add(conn);
		conn.once("close", () => state.connections.delete(conn));
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

	state.server = srv;
	state.socketPath = path;

	// Record the socket file's inode so stop() only unlinks what it owns.
	try {
		state.bindInode = statSync(path).ino;
	} catch {
		state.bindInode = null;
	}

	info("Socket server started", { path, pid: process.pid });

	registerSignalHandlers();
	return { status: "started" };
}

/**
 * Close the socket server and remove the socket file.
 *
 * Forcibly destroys any still-connected clients so server.close() does not
 * wait for them. A 1s defensive deadline resolves the wait even if a client
 * refuses to close, so Pi can always shut down deterministically.
 *
 * The socket file is only unlinked if it is still the one this server bound
 * (inode match); a rebound socket owned by a newer session is left in place.
 *
 * Safe to call repeatedly or concurrently: concurrent calls await the
 * in-flight shutdown.
 */
export async function stop(): Promise<void> {
	if (!state.server) return;
	if (state.stopping) return state.stopping;

	const path = state.socketPath;
	const srv = state.server;
	const bindInode = state.bindInode;

	state.stopping = (async () => {
		// Destroy active clients so their close events fire and server.close()
		// is not blocked by lingering connections.
		for (const conn of state.connections) {
			try {
				conn.destroy();
			} catch {
				// already closed/closing — ignore
			}
		}
		state.connections.clear();

		// Node unlinks the listening path on server.close(). If the path has
		// been rebound by a newer session, move it out of the way first and
		// restore it after close, so a dying old instance cannot delete the
		// new owner's socket file.
		const foreignFile =
			path != null && existsSync(path) && !ownsPath(path, bindInode);
		if (foreignFile) {
			info("Socket file owned by newer session; leaving in place", {
				path,
				pid: process.pid,
			});
		}
		let displaced: string | null = null;
		if (foreignFile && path != null) {
			displaced = `${path}.rebound-${process.pid}`;
			try {
				renameSync(path, displaced);
			} catch (err) {
				warn("Failed to move rebound socket aside", { path, err: String(err) });
				displaced = null;
			}
		}

		// Await close with a defensive deadline.
		let deadlineFired = false;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				deadlineFired = true;
				warn("Socket server close exceeded deadline; continuing shutdown", {
					path,
					timeoutMs: SHUTDOWN_TIMEOUT_MS,
				});
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

		if (displaced) {
			// Restore the newer session's socket file (rename preserves its inode).
			try {
				renameSync(displaced, path as string);
			} catch (err) {
				warn("Failed to restore rebound socket file", {
					path,
					err: String(err),
				});
			}
		} else if (path && existsSync(path)) {
			// close() normally unlinks our own file; clean up defensively.
			try {
				unlinkSync(path);
			} catch (err) {
				warn("Failed to remove socket file on shutdown", {
					path,
					err: String(err),
				});
			}
		}

		info("Socket server stopped", { path, pid: process.pid });
		state.server = null;
		state.socketPath = null;
		state.bindInode = null;
		state.stopping = null;
	})();

	return state.stopping;
}

/**
 * Write a message to all connected clients.
 *
 * Iterates active connections and writes the data to each socket that
 * is not destroyed. Logs each broadcast at debug level.
 */
export function broadcast(data: string): void {
	debug("Broadcasting to connections", {
		count: state.connections.size,
		data: data.trim(),
	});
	for (const conn of state.connections) {
		if (!conn.destroyed) {
			try {
				conn.write(data);
			} catch (err) {
				warn("Failed to write to client", { err: String(err) });
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Whether the socket file at `path` is still the one this server bound.
 * An unknown inode (null) falls back to "owned" — previous unlink behavior.
 */
function ownsPath(path: string, bindInode: number | null): boolean {
	if (bindInode == null) return true;
	try {
		return statSync(path).ino === bindInode;
	} catch {
		return false;
	}
}

/**
 * Probe whether an existing socket is alive by attempting a connection.
 * Returns true if the connection succeeds (server is alive), false if
 * ECONNREFUSED (stale socket) or the probe times out (half-dead listener).
 */
function probeExistingSocket(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const sock: Socket = createConnection(path);

		const timer = setTimeout(() => {
			sock.destroy();
			resolve(false);
		}, PROBE_TIMEOUT_MS);

		sock.once("connect", () => {
			clearTimeout(timer);
			sock.destroy();
			resolve(true);
		});

		sock.once("error", () => {
			clearTimeout(timer);
			sock.destroy();
			resolve(false);
		});
	});
}

/** Handle a single client connection: buffer data, split on newlines. */
function handleConnection(
	conn: Socket,
	onMessage: (data: string) => void,
): void {
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
	if (state.signalsRegistered) return;
	state.signalsRegistered = true;

	const shutdown = async (signal: string) => {
		info("Received signal, shutting down", { signal });
		await stop();
		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}
