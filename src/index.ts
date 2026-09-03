/**
 * pi-bridge.ext
 *
 * Pi extension for Neovim integration via Unix socket.
 * Opens a socket on session start, listens for messages from
 * pi-bridge.nvim, and injects them into the pi session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { socketPath, ensureSocketDir } from "./path.js";
import { broadcast, start, stop } from "./socket.js";
import { parseMessage, serializeEvent } from "./protocol.js";
import type { OutboundEvent } from "./protocol.js";
import { handleMessage } from "./handler.js";
import { setLogLevel, info, warn, error, LOG_PATH } from "./log.js";
import type { LogLevel } from "./log.js";

export default function (pi: ExtensionAPI) {
	// Configure log level from env (default: info)
	const level = (process.env.PI_BRIDGE_LOG_LEVEL ?? "info") as LogLevel;
	setLogLevel(level);

	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const path = socketPath(cwd);

		info("Starting pi-bridge extension", { cwd, socketPath: path, logPath: LOG_PATH });
		ensureSocketDir();

		try {
			const started = await start(path, (raw) => {
				const message = parseMessage(raw);
				if (!message) {
					warn("Received invalid message", { raw });
					return;
				}
				handleMessage(pi, message);
			});

			if (started) {
				info("pi-bridge ready", { socketPath: path });
			} else {
				info("pi-bridge socket already in use", { socketPath: path });
			}
		} catch (err) {
			error("Failed to start pi-bridge socket", { err: String(err) });
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const event: OutboundEvent = { type: "agent_start", message: "working..." };
		info("Agent started", { cwd });
		broadcast(serializeEvent(event));
	});

	pi.on("agent_end", (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const event: OutboundEvent = { type: "agent_end", message: "done" };
		info("Agent completed", { cwd });
		broadcast(serializeEvent(event));
	});

	pi.on("session_shutdown", async () => {
		info("Shutting down pi-bridge extension");
		await stop();
	});
}
