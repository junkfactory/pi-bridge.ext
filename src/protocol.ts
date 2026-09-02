/**
 * Message protocol: types, parsing, validation, serialization.
 *
 * Protocol is JSON over Unix socket. Each message is a single JSON object
 * terminated by newline (\n).
 */

/** Message from Neovim → pi. */
export type InboundMessage = PromptMessage;

/** Prompt with context from Neovim. */
export interface PromptMessage {
	type: "prompt";
	text: string;
	context: {
		file: string;
		cwd: string;
		content: string;
		mode: "normal" | "visual";
	};
}

/** Message from pi → Neovim. */
export interface OutboundEvent {
	type: "event";
	event: string;
	data: Record<string, unknown>;
}

/**
 * Parse a raw JSON string into a validated InboundMessage.
 * Returns the message or null if malformed/unknown type.
 */
export function parseMessage(raw: string): InboundMessage | null {
	// TODO: implement parsing + validation
	return null;
}

/** Serialize an outbound event for sending over the socket. */
export function serializeEvent(event: OutboundEvent): string {
	return JSON.stringify(event);
}
