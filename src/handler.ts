/**
 * Inbound message handler.
 *
 * Dispatches parsed messages to the pi API. Each message type
 * has its own handler function.
 */

import { basename } from "node:path";
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
 * Format a file path as a clickable markdown link.
 * Returns null if the path is empty or not absolute.
 */
function formatFileLink(file: string): string | null {
	if (!file || !file.startsWith("/")) return null;
	return `File: [${basename(file)}](${file})`;
}

/**
 * Send a prompt message to pi as a user message.
 * Prepends the source file as a clickable markdown link when available.
 */
function handlePrompt(pi: ExtensionAPI, message: PromptMessage): void {
	const fileLink = formatFileLink(message.context.file);
	const text = fileLink ? `${fileLink}\n\n${message.text}` : message.text;
	pi.sendUserMessage(text);
}
