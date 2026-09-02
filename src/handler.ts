/**
 * Inbound message handler.
 *
 * Dispatches parsed messages to the pi API. Each message type
 * has its own handler function.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InboundMessage, PromptMessage } from "./protocol.js";

/**
 * Handle a parsed message from Neovim.
 * Routes to the appropriate handler based on message type.
 */
export function handleMessage(pi: ExtensionAPI, message: InboundMessage): void {
	switch (message.type) {
		case "prompt":
			handlePrompt(pi, message);
			break;
	}
}

/**
 * Send a prompt message to pi as a user message.
 *
 * Prepends editor context (file, cwd, mode) so the agent can see
 * where the message originated.
 */
function handlePrompt(pi: ExtensionAPI, message: PromptMessage): void {
	const { context, text } = message;
	const parts = [`file: ${context.file}`, `cwd: ${context.cwd}`, `mode: ${context.mode}`];
	if (context.filetype) parts.push(`filetype: ${context.filetype}`);
	const header = `[${parts.join(", ")}]`;
	pi.sendUserMessage(`${header} ${text}`);
}
