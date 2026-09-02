/**
 * Socket path computation.
 *
 * Each pi session gets a unique socket based on cwd:
 *   ~/.pi/agent/pi-bridge/sockets/<sha256(cwd)>.sock
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SOCKET_DIR = ".pi/agent/pi-bridge/sockets";

/** SHA256 of absolute cwd, hex-encoded (64 chars). */
export function hashCwd(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex");
}

/** Full socket path for the given cwd. */
export function socketPath(cwd: string): string {
	const home = process.env.HOME ?? "";
	return join(home, SOCKET_DIR, `${hashCwd(cwd)}.sock`);
}

/** Ensure the socket directory exists. */
export function ensureSocketDir(): void {
	const home = process.env.HOME ?? "";
	mkdirSync(join(home, SOCKET_DIR), { recursive: true });
}
