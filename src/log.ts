/**
 * Structured file logger.
 *
 * Appends timestamped log lines to ~/.pi/agent/pi-bridge.log.
 * Levels: trace, debug, info, warn, error.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};

const LOG_PATH = join(
	process.env.HOME ?? "",
	".pi/agent/pi-bridge.log",
);

let minLevel: LogLevel = "info";

/** Configure the minimum log level. */
export function setLogLevel(level: LogLevel): void {
	minLevel = level;
}

/** Log a message at the given level. */
export function log(level: LogLevel, message: string, data?: unknown): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

	const timestamp = new Date().toISOString();
	const prefix = `[${timestamp}] [${level.toUpperCase().padEnd(5)}]`;
	const line = data !== undefined
		? `${prefix} ${message} ${JSON.stringify(data)}\n`
		: `${prefix} ${message}\n`;

	try {
		mkdirSync(dirname(LOG_PATH), { recursive: true });
		appendFileSync(LOG_PATH, line);
	} catch {
		// Logging should never crash the extension
	}
}

/** Convenience helpers per level. */
export const trace = (msg: string, data?: unknown) => log("trace", msg, data);
export const debug = (msg: string, data?: unknown) => log("debug", msg, data);
export const info = (msg: string, data?: unknown) => log("info", msg, data);
export const warn = (msg: string, data?: unknown) => log("warn", msg, data);
export const error = (msg: string, data?: unknown) => log("error", msg, data);
