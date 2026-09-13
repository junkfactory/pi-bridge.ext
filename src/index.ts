/**
 * pi-bridge.ext
 *
 * Pi extension for Neovim integration via Unix socket.
 * Opens a socket on session start, listens for messages from
 * pi-bridge.nvim, and injects them into the pi session.
 *
 * Also implements the edit-approval gate: before pi's built-in `edit` and
 * `write` tools modify a file, approval is requested via the bridge
 * socket (Neovim) — and, in parallel, a focused `y / a(ll this file) / n`
 * prompt replaces pi's input box so the user can answer locally. Disable
 * via `PI_BRIDGE_EDIT_APPROVAL=0`.
 */

/**
 * Standing system-prompt instruction steering the agent away from shell
 * file mutations (which the approval gate cannot see) toward the gated
 * edit/write tools. Appended to every turn's system prompt by the
 * `before_agent_start` handler while the gate is enabled.
 */
export const EDIT_TOOL_GUARD = [
	"File-editing policy: apply all file changes with the `edit` and `write` tools.",
	"Never modify files through bash — no `sed -i`, `perl -i`, `tee`, output redirection",
	"(> / >>), `mv`/`cp` overwrites, heredocs into files, or scripts that write files.",
	"edit/write calls show a diff preview for user approval; shell mutations bypass it.",
].join("\n");

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type {
	AgentEndEvent,
	BeforeAgentStartEventResult,
	EditToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEventResult,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { createGate, type Gate } from "./approval.js";
import { buildDiff } from "./diff.js";
import { handleMessage } from "./handler.js";
import type { LogLevel } from "./log.js";
import { debug, error, info, logPath, setLogLevel, warn } from "./log.js";
import { ensureSocketDir, socketPath } from "./path.js";
import type { ErrorCode, OutboundEvent } from "./protocol.js";
import { parseMessage, serializeEvent } from "./protocol.js";
import { broadcast, setOnDisconnect, start, stop } from "./socket.js";
import { type PromptDecision, promptSelection } from "./ui.js";

/**
 * Origin flag: set true when the current agent turn was started by an
 * inbound Neovim `prompt` message, and cleared on session/agent
 * boundaries. The edit-approval gate uses this to skip the prompt
 * entirely for turns the user typed directly into pi — those edits
 * auto-allow with no TUI surface.
 *
 * Stored on globalThis so the value survives module reloads (jiti
 * re-evaluates the extension factory more than once per process), and
 * so tests can reset it between cases without a separate test-only
 * export.
 */
const globalScopeForOrigin = globalThis as typeof globalThis & {
	__piBridgeNvimTurnActive?: boolean;
};
function getNvimTurnActive(): boolean {
	return globalScopeForOrigin.__piBridgeNvimTurnActive === true;
}
function setNvimTurnActive(v: boolean): void {
	globalScopeForOrigin.__piBridgeNvimTurnActive = v;
}

/**
 * Map of ExtensionAPI instances by sessionId, shared across jiti module
 * re-evaluations. The socket's message callback outlives session replacements,
 * so it must resolve `pi` at message time — a captured old `pi` or `ctx` is
 * stale after ctx.newSession()/fork()/switchSession()/reload() and throws.
 * The callback therefore must not close over the `ctx` passed to
 * `session_start` either: pi may evaluate the extension factory more than
 * once per process (e.g. rebind at startup), and whichever instance binds
 * the socket first, its captured ctx is dead by the time messages arrive.
 *
 * Each session's `pi` is registered in the map with its sessionId. When a
 * message arrives, we look up the owner's `pi` by `ownerSessionId`. This is
 * order-independent — shutdowns can happen in any order without breaking the
 * lookup.
 *
 * The `ownerSessionId` field tracks which session started the socket.
 * Only the owner may tear the socket down — child sessions (e.g. from
 * pi-subagents) that also load this extension must not kill the parent's
 * socket when they shut down.
 */
const globalScope = globalThis as typeof globalThis & {
	__piBridgePiMap?: Map<string, ExtensionAPI>;
	__piBridgeOwnerSessionId?: string | null;
	__piBridgeGate?: Gate | null;
};

function getPiMap(): Map<string, ExtensionAPI> {
	if (!globalScope.__piBridgePiMap) {
		globalScope.__piBridgePiMap = new Map();
	}
	return globalScope.__piBridgePiMap;
}

function getActivePi(): ExtensionAPI | null {
	const ownerSessionId = globalScope.__piBridgeOwnerSessionId;
	if (!ownerSessionId) return null;
	return getPiMap().get(ownerSessionId) ?? null;
}

/**
 * Shared singleton approval gate. Stored on globalThis so module reloads
 * (jiti evaluates the extension factory more than once per process) adopt
 * the live gate instead of leaving orphan instances hanging on the socket
 * state.
 */
function getGate(): Gate {
	if (!globalScope.__piBridgeGate) {
		globalScope.__piBridgeGate = createGate({
			broadcast: (data) => broadcast(data),
			onResolved: (id) => {
				// Tell Neovim the request is settled so its picker can
				// dismiss even when the user answered in pi.
				broadcast(serializeEvent({ type: "approval_resolved", id }));
			},
		});
		// Wire socket disconnects to the gate. The gate's handleDisconnect is
		// a no-op for the pending request itself — the pi prompt stays open
		// awaiting the user's answer; we just give the gate a chance to log
		// if it ever needs to.
		setOnDisconnect(() => {
			globalScope.__piBridgeGate?.handleDisconnect();
		});
	}
	return globalScope.__piBridgeGate;
}

/** Reset and re-install the gate (used by session lifecycle hooks). */
function resetGate(): void {
	if (globalScope.__piBridgeGate) {
		globalScope.__piBridgeGate.reset();
	}
	// Session boundaries always clear the origin flag — a fresh session
	// starts in pi-typed mode until nvim sends a new prompt.
	setNvimTurnActive(false);
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

/**
 * Map an ApprovalResult (from the gate) or a PromptDecision (from the
 * pi-side prompt) to a tool_call result. Centralized so both race paths
 * share the exact same mapping (logs and block reasons).
 */
function mapDecision(
	decision: "yes" | "all" | "no" | "cancelled",
	path: string,
	tool: string,
): ToolCallEventResult | undefined {
	switch (decision) {
		case "yes":
		case "all":
			info("Edit-approval gate: approved", { path, tool, decision });
			return undefined;
		case "no":
			info("Edit-approval gate: rejected", { path, tool });
			return { block: true, reason: `User rejected edit to ${path}` };
		case "cancelled":
			info("Edit-approval gate: cancelled", { path, tool });
			return { block: true, reason: "Edit approval cancelled" };
	}
}

export default function (pi: ExtensionAPI) {
	// Configure log level from env (default: info)
	const level = (process.env.PI_BRIDGE_LOG_LEVEL ?? "info") as LogLevel;
	setLogLevel(level);

	pi.on("session_start", async (_event, ctx) => {
		// Edit-approval gate: clear per-file "all" memory at session start
		// so a new session re-prompts even for previously-approved files.
		// Also clears the origin flag — a fresh session starts in
		// pi-typed mode.
		resetGate();

		const cwd = ctx.cwd ?? process.cwd();
		const path = socketPath(cwd);

		const sessionId = ctx.sessionManager.getSessionId();

		info("Starting pi-bridge extension", {
			cwd,
			socketPath: path,
			logPath: logPath(),
			sessionId,
			model: ctx.model?.name,
			reason: _event.reason,
			mapSize: getPiMap().size,
			isOwner: !globalScope.__piBridgeOwnerSessionId,
		});
		ensureSocketDir();

		getPiMap().set(sessionId, pi);
		if (!globalScope.__piBridgeOwnerSessionId) {
			globalScope.__piBridgeOwnerSessionId = sessionId;
		}
		try {
			const result = await start(path, (raw) => {
				const message = parseMessage(raw);
				if (!message) {
					warn("Received invalid message", { raw });
					return;
				}
				// Never touch the captured `ctx` here — it is stale after session
				// replacement and throws. The owner session id in shared state is
				// the live session this socket dispatches into.
				const sid = globalScope.__piBridgeOwnerSessionId;
				info("Inbound message", {
					type: message.type,
					textLength: message.type === "prompt" ? message.text.length : 0,
					sessionId: sid,
				});
				if (message.type === "prompt" && message.text) {
					const preview = message.text.slice(0, 50);
					debug("Inbound message preview", {
						preview,
						sessionId: sid,
					});
				}
				try {
					const active = getActivePi();
					if (!active) {
						const code: ErrorCode = "no_active_pi";
						error("No active extension API for inbound message", {
							type: message.type,
							code,
							sessionId: sid,
						});
						broadcast(
							serializeEvent({
								type: "error",
								message: "Failed to deliver message to pi",
								code,
							}),
						);
						return;
					}
					// Origin flag: an inbound prompt marks the current turn as
					// nvim-originated so the gate's edit/write path will prompt
					// instead of auto-allowing. Cleared on agent_end and on
					// session boundaries.
					if (message.type === "prompt") setNvimTurnActive(true);
					handleMessage(active, message);
					debug("Dispatch succeeded", {
						type: message.type,
						sessionId: sid,
					});
				} catch (err) {
					const errStr = String(err);
					const code: ErrorCode =
						errStr.includes("stale") || errStr.includes("extension ctx")
							? "stale_context"
							: "send_failed";
					error("Dispatch failed", {
						type: message.type,
						code,
						err: errStr,
						sessionId: sid,
					});
					broadcast(
						serializeEvent({
							type: "error",
							message: "Failed to deliver message to pi",
							code,
						}),
					);
				}
			});

			switch (result.status) {
				case "started":
					info("pi-bridge ready", { socketPath: path });
					break;
				case "already-hosted":
					info("pi-bridge socket already hosted", {
						socketPath: path,
					});
					break;
				case "foreign-owner":
					warn("pi-bridge socket owned by another pi instance", {
						socketPath: path,
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

	// -----------------------------------------------------------------
	// Edit-approval gate: intercept edit/write tool calls from
	// nvim-originated turns. Pi-typed turns skip the gate entirely
	// (the user already saw the prompt in their own input box). When
	// gated, both the Neovim picker and a focused pi-side prompt are
	// shown; first answer wins. nvim disconnecting mid-prompt does
	// not resolve the request — the pi prompt stays open.
	//
	// The gate only sees edit/write; agents can still mutate files via
	// bash (sed -i, redirects, ...). Policing shell commands is
	// whack-a-mole, so instead every turn's system prompt carries a
	// standing instruction to use the gated tools (see EDIT_TOOL_GUARD).
	// -----------------------------------------------------------------
	pi.on(
		"before_agent_start",
		(event): BeforeAgentStartEventResult | undefined => {
			// Same kill-switch as the gate itself.
			if (process.env.PI_BRIDGE_EDIT_APPROVAL === "0") return undefined;
			return {
				systemPrompt: `${event.systemPrompt}\n\n${EDIT_TOOL_GUARD}`,
			};
		},
	);

	pi.on(
		"tool_call",
		async (event, ctx): Promise<ToolCallEventResult | undefined> => {
			// Kill-switch (env var disables the whole gate without a rebuild).
			if (process.env.PI_BRIDGE_EDIT_APPROVAL === "0") return undefined;

			// Narrow to edit / write. Other tools (bash, read, ...) are
			// deliberately untouched — only file mutations gate on approval.
			const isEdit = isToolCallEventType("edit", event);
			const isWrite = isToolCallEventType("write", event);
			if (!isEdit && !isWrite) return undefined;

			// Origin gate: edits from turns the user typed directly into pi
			// auto-allow. Only turns started by an inbound Neovim prompt are
			// gated — the user already saw nvim's picker.
			if (!getNvimTurnActive()) return undefined;

			// Headless (print / JSON / RPC) runs have no UI to ask on — auto-
			// approve so non-interactive workflows aren't blocked.
			if (!ctx.hasUI) {
				info("Edit-approval gate: auto-approve (no UI)", {
					tool: isEdit ? "edit" : "write",
					path: (event as EditToolCallEvent | WriteToolCallEvent).input.path,
				});
				return undefined;
			}

			const toolName = isEdit ? "edit" : "write";
			const toolEvent = event as EditToolCallEvent | WriteToolCallEvent;
			const input = toolEvent.input as Parameters<typeof buildDiff>[1];
			const cwd = ctx.cwd ?? process.cwd();

			const diffResult = await buildDiff(toolName, input, cwd);
			if (!diffResult) {
				// Nothing meaningful to preview (e.g. an edit with no edits and
				// no existing file). Let the tool run — it will fail upstream
				// on its own if needed.
				return undefined;
			}

			const gate = getGate();
			const id = randomUUID();

			// Race the gate's natural settlement (nvim response, abort, or
			// session reset) against the user's local pi-prompt decision.
			// First answer wins; the other path is cleaned up best-effort.
			const gatePromise = gate.requestApproval({
				id,
				tool: toolName,
				path: diffResult.path,
				diff: diffResult.diff,
				signal: ctx.signal,
			});

			// Pi-side prompt: independent of the gate's pending state. If
			// nvim responds while the prompt is up, the gate settles and
			// broadcasts approval_resolved (dismisses nvim's picker), and
			// the pi prompt is dismissed below — a late keypress would be
			// a no-op because handleResponse short-circuits on unknown ids.
			const prompt = promptSelection(ctx);
			const promptPromise = prompt.decision.then((decision: PromptDecision) => {
				// Feed the pi-side decision back through the gate so
				// per-file memory updates (for "all") and the single
				// approval_resolved broadcast fire exactly once via
				// onResolved. Esc cancels the pending request without
				// marking the path as approved.
				if (decision === "cancelled") {
					gate.handleCancel(id);
				} else {
					gate.handleResponse(id, decision);
				}
				return decision;
			});

			// Await whichever settles first. The loser keeps running but
			// its eventual resolution is ignored (gate.handleResponse
			// no-ops on unknown ids; the prompt just resolves to a
			// discarded decision).
			const winner = await Promise.race([
				gatePromise.then((o) => ({ kind: "gate" as const, ...o })),
				promptPromise.then((d) => ({ kind: "pi" as const, decision: d })),
			]);

			if (winner.kind === "gate") {
				// The gate settled first (nvim answered, Ctrl+C abort, or a
				// session reset) — tear the pi prompt down so the editor is
				// restored. The prompt's late "cancelled" feeds handleCancel,
				// which no-ops (first-wins).
				prompt.dismiss();
				return mapDecision(winner.result, diffResult.path, toolName);
			}
			// Pi won — the gate already settled (via our handleResponse
			// call above) before Promise.race returned.
			return mapDecision(winner.decision, diffResult.path, toolName);
		},
	);

	pi.on("agent_start", (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		const sessionId = ctx.sessionManager.getSessionId();
		const event: OutboundEvent = {
			type: "agent_start",
			message: buildStartMessage(ctx),
		};
		info("Agent started", {
			cwd,
			sessionId,
			model: ctx.model?.name,
			ownerSessionId: globalScope.__piBridgeOwnerSessionId,
		});
		broadcast(serializeEvent(event));
	});

	pi.on("agent_end", (_event, _ctx) => {
		// End of the nvim-originated turn — drop the origin flag so any
		// follow-up edits typed directly in pi auto-allow again.
		setNvimTurnActive(false);

		const cwd = _ctx.cwd ?? process.cwd();
		const sessionId = _ctx.sessionManager.getSessionId();
		const event: OutboundEvent = {
			type: "agent_end",
			message: buildEndMessage(_event),
		};
		info("Agent completed", {
			cwd,
			sessionId,
			model: _ctx.model?.name,
			ownerSessionId: globalScope.__piBridgeOwnerSessionId,
		});
		broadcast(serializeEvent(event));
	});

	// -----------------------------------------------------------------
	// Edit-approval gate: clear per-file "all" memory + origin flag at
	// session boundaries so a fresh session re-prompts even for files
	// the previous session had approved. Hooks ride alongside the
	// existing session lifecycle handlers — don't replace them.
	// -----------------------------------------------------------------
	pi.on("session_before_switch", () => {
		resetGate();
	});
	// No reset on session_shutdown: session switches tear down via
	// session_before_switch + the next session_start, and we want in-flight
	// requests to settle first on a real quit.

	pi.on("session_shutdown", async (event, ctx) => {
		// Drop the origin flag on shutdown — leak-proofing. If a child
		// session shutdown (non-owner) happens, the flag is cleared too,
		// but the owner's session_start will re-establish it for any
		// follow-up nvim prompts.
		setNvimTurnActive(false);

		const sessionId = ctx.sessionManager.getSessionId();
		getPiMap().delete(sessionId);
		info("Removed session from pi map", {
			sessionId,
			mapSize: getPiMap().size,
			reason: event.reason,
		});
		// Only a real quit tears the socket down. Session switches (new, resume,
		// fork, reload) must keep the socket alive so nvim stays connected.
		if (event.reason !== "quit") {
			// If this session was the owner, clear ownership so a new session
			// can claim the socket (the socket itself stays alive).
			if (sessionId === globalScope.__piBridgeOwnerSessionId) {
				globalScope.__piBridgeOwnerSessionId = null;
			}
			info("pi-bridge socket kept across session switch", {
				reason: event.reason,
			});
			return;
		}
		// Only the session that started the socket may tear it down. Child
		// sessions (e.g. from pi-subagents) emit session_shutdown with
		// reason "quit" when they finish — but they must not kill the
		// parent's socket.
		if (sessionId !== globalScope.__piBridgeOwnerSessionId) {
			info("pi-bridge socket kept alive — child session shutdown");
			return;
		}
		info("Shutting down pi-bridge extension");
		globalScope.__piBridgeOwnerSessionId = null;
		await stop();
	});
}
