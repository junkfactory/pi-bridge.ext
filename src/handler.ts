/**
 * Inbound message handler.
 *
 * Dispatches parsed messages to the pi API. Each message type
 * has its own handler function.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Gate } from "./approval.js";
import type {
	ApprovalDecision,
	InboundMessage,
	PromptMessage,
} from "./protocol.js";

/**
 * Shared globalThis state for the approval gate. Mirrors the pattern in
 * `src/index.ts` (singleton pi map) and `src/socket.ts` (singleton server
 * state) — jiti may re-evaluate this module on session switch / reload,
 * so any per-process singleton must live on `globalThis` to survive.
 */
const globalScope = globalThis as typeof globalThis & {
	__piBridgeGate?: Gate | null;
};

function getGate(): Gate | null {
	return globalScope.__piBridgeGate ?? null;
}

/**
 * Handle a parsed message from Neovim.
 * Routes to the appropriate handler based on message type.
 */
export function handleMessage(pi: ExtensionAPI, message: InboundMessage): void {
	switch (message.type) {
		case "prompt":
			handlePrompt(pi, message);
			break;
		case "approval_ack":
			handleApprovalAck(message.id);
			break;
		case "approval_response":
			handleApprovalResponse(message.id, message.decision);
			break;
	}
}

function handleApprovalAck(id: string): void {
	const gate = getGate();
	if (!gate) return; // gate not installed yet (early message)
	gate.handleAck(id);
}

function handleApprovalResponse(id: string, decision: ApprovalDecision): void {
	const gate = getGate();
	if (!gate) return;
	gate.handleResponse(id, decision);
}

/**
 * Format a file path as a clickable markdown link.
 * Returns null if the path is empty or not absolute.
 */
function formatFileLink(file: string): string | null {
	if (!file?.startsWith("/")) return null;
	return `File: [${basename(file)}](${file})`;
}

/**
 * Resolve a source file reference into a renderable mention.
 * - "absent"  → no path supplied (or not absolute); render nothing
 * - "missing" → path supplied but file does not exist on disk; render a hint
 * - "link"    → path supplied and file exists; render a clickable markdown link
 */
type FileMention =
	| { kind: "link"; text: string }
	| { kind: "missing" | "absent" };

function resolveFileMention(file: string): FileMention {
	if (!file?.startsWith("/")) return { kind: "absent" };
	if (!existsSync(file)) return { kind: "missing" };
	return { kind: "link", text: `File: [${basename(file)}](${file})` };
}

/**
 * Send a prompt message to pi as a user message.
 * Uses `buffer_state` from the protocol when available to emit tailored hints:
 * - "scratch"   → ephemeral buffer; hint to ask user for the real path
 * - "modified"  → file may have unsaved changes; hint to request contents
 * - "unsaved" / "nameless" → no path; hint to ask for location/contents
 * - "saved"     → file is on disk and unmodified; render a clickable link (trust nvim)
 * Falls back to `existsSync` when `buffer_state` is absent (old sender).
 */
function handlePrompt(pi: ExtensionAPI, message: PromptMessage): void {
	const state = message.context.buffer_state;
	let text = message.text;

	if (state === "scratch") {
		text = `[Hint: The source buffer is an ephemeral scratch copy — the path "${message.context.file}" will not persist. Do not edit that file. Ask the user for the real file or request contents.]\n\n${text}`;
	} else if (state === "modified") {
		text = `[Hint: The file "${message.context.file}" may have unsaved changes in Neovim. Ask the user or request current contents before editing.]\n\n${text}`;
	} else if (state === "unsaved" || state === "nameless") {
		text = `[Hint: The source buffer is unsaved in Neovim (no file path). Do not search for the file — ask the user for the location or its contents.]\n\n${text}`;
	} else if (state === "saved") {
		// nvim confirms the file is on disk and unmodified — trust the signal
		const link = formatFileLink(message.context.file);
		if (link) text = `${link}\n\n${text}`;
	} else {
		// No buffer_state from nvim (old sender) — use existsSync fallback
		const mention = resolveFileMention(message.context.file);
		if (mention.kind === "link") {
			text = `${mention.text}\n\n${text}`;
		} else if (mention.kind === "missing") {
			text = `[Hint: The source file "${message.context.file}" does not exist on disk. It may be an unsaved buffer in Neovim. Do not search for this file — ask the user for its location or contents.]\n\n${text}`;
		}
	}

	pi.sendUserMessage(text);
}
