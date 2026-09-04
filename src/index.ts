/**
 * pi-bridge.ext
 *
 * Pi extension for Neovim integration via Unix socket.
 * Opens a socket on session start, listens for messages from
 * pi-bridge.nvim, and injects them into the pi session.
 */

import { basename } from "node:path";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { handleMessage } from "./handler.js";
import type { LogLevel } from "./log.js";
import { error, info, LOG_PATH, setLogLevel, warn } from "./log.js";
import { ensureSocketDir, socketPath } from "./path.js";
import type { OutboundEvent } from "./protocol.js";
import { parseMessage, serializeEvent } from "./protocol.js";
import { broadcast, start, stop } from "./socket.js";

/**
 * The ExtensionAPI of the most recent extension instance, shared across jiti
 * module re-evaluations. The socket's message callback outlives session
 * replacements, so it must resolve `pi` at message time — a captured old `pi`
 * is stale after ctx.newSession()/fork()/switchSession()/reload() and throws.
 */
const globalScope = globalThis as typeof globalThis & {
	__piBridgeApi?: { pi: ExtensionAPI | null };
};

function setActivePi(pi: ExtensionAPI): void {
	if (!globalScope.__piBridgeApi) {
		globalScope.__piBridgeApi = { pi: null };
	}
	globalScope.__piBridgeApi.pi = pi;
}

function getActivePi(): ExtensionAPI | null {
	return globalScope.__piBridgeApi?.pi ?? null;
}

export function buildStartMessage(ctx: ExtensionContext): string {
	const model = ctx.model?.name ?? ctx.model?.id ?? "agent";
	const level = ctx.thinkingLevel;
	const usage = ctx.getContextUsage();
	const brain =
		usage?.percent != null && usage.percent > 0 ? usage.percent : null;

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
		.filter(
			(m) =>
				(m.role === "toolResult" && m.isError) ||
				(m.role === "assistant" && m.stopReason === "error"),
		)
		.flatMap(
			(m) =>
				(m as { content?: Array<{ type?: unknown; text?: unknown }> }).content
					?.filter((part) => part.type === "text")
					.map((part) => part.text as string | undefined) ?? [],
		)
		.find((text) => text?.trim());

	let result = "done";
	if (parts.length > 0) result += ` — ${parts.join(" · ")}`;
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

		info("Starting pi-bridge extension", {
			cwd,
			socketPath: path,
			logPath: LOG_PATH,
		});
		ensureSocketDir();

		setActivePi(pi);
		try {
			const result = await start(path, (raw) => {
				const message = parseMessage(raw);
				if (!message) {
					warn("Received invalid message", { raw });
					return;
				}
				const active = getActivePi();
				if (!active) {
					warn("No active extension API for inbound message", { raw });
					return;
				}
				handleMessage(active, message);
			});

			switch (result.status) {
				case "started":
					info("pi-bridge ready", { socketPath: path, pid: process.pid });
					break;
				case "already-hosted":
					info("pi-bridge socket already hosted", {
						socketPath: path,
						pid: process.pid,
					});
					break;
				case "foreign-owner":
					warn("pi-bridge socket owned by another pi instance", {
						socketPath: path,
						pid: process.pid,
					});
					ctx.ui.notify(
						"pi-bridge: another pi instance is running for this directory — pi-bridge not hosting this session",
						"warning",
					);
					break;
				case "skipped":
					break;
			}
		} catch (err) {
			error("Failed to start pi-bridge socket", { err: String(err) });
		}
	});

	pi.on("agent_start", (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const event: OutboundEvent = {
			type: "agent_start",
			message: buildStartMessage(ctx),
		};
		info("Agent started", { cwd });
		broadcast(serializeEvent(event));
	});

	pi.on("agent_end", (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const event: OutboundEvent = {
			type: "agent_end",
			message: buildEndMessage(_event),
		};
		info("Agent completed", { cwd });
		broadcast(serializeEvent(event));
	});

	pi.on("session_shutdown", async (event) => {
		// Only a real quit tears the socket down. Session switches (new, resume,
		// fork, reload) must keep the socket alive so nvim stays connected.
		if (event.reason !== "quit") {
			info("pi-bridge socket kept across session switch", {
				reason: event.reason,
				pid: process.pid,
			});
			return;
		}
		info("Shutting down pi-bridge extension", { pid: process.pid });
		await stop();
	});
}
