/**
 * Unix socket lifecycle.
 *
 * Creates a Unix domain server, handles connections, and cleans up
 * stale sockets from previous sessions.
 */

import type { Server } from "node:net";

/** Active socket server, null when not running. */
let server: Server | null = null;

/**
 * Start listening on the given socket path.
 * Handles idempotent activation: if the socket already exists and is
 * alive, this is a noop. If stale (ECONNREFUSED), removes and recreates.
 */
export async function start(
	socketPath: string,
	onMessage: (data: string) => void,
): Promise<void> {
	// TODO: implement socket creation, stale detection, connection handling
}

/** Close the socket server and remove the socket file. */
export async function stop(): Promise<void> {
	// TODO: implement cleanup
}
