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
 * The Neovim side is responsible for shaping the text it sends; the
 * handler passes the message through verbatim.
 */
function handlePrompt(pi: ExtensionAPI, message: PromptMessage): void {
	pi.sendUserMessage(message.text);
}
