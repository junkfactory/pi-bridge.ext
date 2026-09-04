/**
 * pi-bridge.ext
 *
 * Pi extension for Neovim integration via Unix socket.
 * Opens a socket on session start, listens for messages from
 * pi-bridge.nvim, and injects them into the pi session.
 */

import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { socketPath, ensureSocketDir } from "./path.js";
import { broadcast, start, stop } from "./socket.js";
import { parseMessage, serializeEvent } from "./protocol.js";
import type { OutboundEvent } from "./protocol.js";
import { handleMessage } from "./handler.js";
import { setLogLevel, info, warn, error, LOG_PATH } from "./log.js";
import type { LogLevel } from "./log.js";

export function buildStartMessage(ctx: ExtensionContext): string {
	const model = ctx.model?.name ?? ctx.model?.id ?? "agent";
	const level = ctx.thinkingLevel;
	const usage = ctx.getContextUsage();
	const brain = usage?.percent != null && usage.percent > 0 ? usage.percent : null;

	let msg = model;
	msg += level && level !== "off" ? ` is thinking in ${level}` : " is thinking";
	if (brain != null) msg += ` at ${brain.toFixed(2)}% brain usage`;
	return msg;
}

function buildEndMessage(event: AgentEndEvent): string {
	const messages = event.messages ?? [];

	// Count turns (assistant messages)
	const turns = messages.filter((m) => m.role === "assistant").length;

	// Collect unique tool names from tool_use blocks
	const toolNames = new Set<string>();
	// Collect unique file paths from tool arguments
	const files = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					toolNames.add(block.name);
					// Extract file paths from common tool args
					const path = block.arguments?.path ?? block.arguments?.file;
					if (typeof path === "string") {
						files.add(basename(path));
					}
				}
			}
		}
	}

	const parts: string[] = [];
	if (turns > 0) parts.push(`${turns} turn${turns !== 1 ? "s" : ""}`);
	if (toolNames.size > 0) {
		parts.push(`used ${toolNames.size} tool${toolNames.size !== 1 ? "s" : ""}`);
	}
	if (files.size > 0) {
		parts.push(`touched ${files.size} file${files.size !== 1 ? "s" : ""}`);
	}

	const errorMessage = messages
		.filter((m) => (m.role === "toolResult" && m.isError) || (m.role === "assistant" && m.stopReason === "error"))
		.flatMap((m) =>
			(m as any).content?.filter((part: any) => part.type === "text").map((part: any) => part.text) ?? [],
		)
		.find((text) => text?.trim());

	let result = "done";
	if (parts.length > 0) result += " — " + parts.join(" · ");
	if (errorMessage) result += ` / ${errorMessage}`;
	return result;
}

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
		const event: OutboundEvent = { type: "agent_start", message: buildStartMessage(ctx) };
		info("Agent started", { cwd });
		broadcast(serializeEvent(event));
	});

	pi.on("agent_end", (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const event: OutboundEvent = { type: "agent_end", message: buildEndMessage(_event) };
		info("Agent completed", { cwd });
		broadcast(serializeEvent(event));
	});

	pi.on("session_shutdown", async () => {
		info("Shutting down pi-bridge extension");
		await stop();
	});
}
