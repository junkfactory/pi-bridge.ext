/**
 * Inbound message handler.
 *
 * Dispatches parsed messages to the pi API. Each message type
 * has its own handler function.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InboundMessage, PromptMessage } from "./protocol.js";
import { debug } from "./log.js";

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
 * Send a prompt message to pi as a user message with editor context.
 *
 * Formats the Neovim context (file, mode, selection) as a preamble
 * so the agent knows where the request originated.
 */
function handlePrompt(pi: ExtensionAPI, message: PromptMessage): void {
	const { text, context } = message;

	const parts: string[] = [];

	// Context preamble
	if (context.file) {
		let location = `File: ${context.file}`;
		if (context.cursor) {
			location += ` (line ${context.cursor.line}, col ${context.cursor.col})`;
		}
		parts.push(location);
	}
	if (context.filetype) {
		parts.push(`Language: ${context.filetype}`);
	}
	if (context.mode === "visual") {
		parts.push("(Visual selection)");
	}

	// User's message
	parts.push("");
	parts.push(text);

	// Current line (normal mode)
	if (context.current_line) {
		parts.push("");
		parts.push(`Current line: \`${context.current_line}\``);
	}

	// Code context — visual selection or surrounding lines
	if (context.content) {
		parts.push("");
		parts.push("```");
		parts.push(context.content);
		parts.push("```");
	} else if (context.surrounding) {
		parts.push("");
		parts.push("Surrounding code:");
		parts.push("```");
		parts.push(context.surrounding);
		parts.push("```");
	}

	const formatted = parts.join("\n");
	debug("Sending prompt to pi", { file: context.file, mode: context.mode });
	pi.sendUserMessage(formatted);
}
