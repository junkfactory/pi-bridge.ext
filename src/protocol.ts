/**
 * Message protocol: types, parsing, validation, serialization.
 *
 * Protocol is newline-delimited JSON over Unix socket.
 * Each message is a single JSON object followed by \n.
 */

// ---------------------------------------------------------------------------
// Inbound messages (Neovim → pi)
// ---------------------------------------------------------------------------

/** All message types Neovim can send. */
export type InboundMessage = PromptMessage;

/** Prompt with editor context from Neovim. */
export interface PromptMessage {
	type: "prompt";
	text: string;
	context: {
		file: string;
		cwd: string;
		mode: "normal" | "visual";
		filetype?: string;
		buffer_state?: "nameless" | "scratch" | "unsaved" | "modified" | "saved";
	};
}

// ---------------------------------------------------------------------------
// Outbound messages (pi → Neovim)
// ---------------------------------------------------------------------------

/** Event pushed to Neovim. */
export interface OutboundEvent {
	type: "agent_start" | "agent_end";
	message: string;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/** Separator for newline-delimited JSON. */
export const FRAME_DELIMITER = "\n";

/**
 * Split a raw buffer into complete messages.
 * Returns an array of JSON strings, each a complete message.
 * If the buffer doesn't end with \n, the trailing partial is returned
 * separately so the caller can re-prepend it on the next chunk.
 */
export function frameBuffer(buffer: string): {
	messages: string[];
	remainder: string;
} {
	const parts = buffer.split(FRAME_DELIMITER);
	// Last element is either empty (buffer ended with \n) or a partial message
	const remainder = parts.pop() ?? "";
	const messages = parts.filter((p) => p.length > 0);
	return { messages, remainder };
}

// ---------------------------------------------------------------------------
// Parsing & validation
// ---------------------------------------------------------------------------

/**
 * Parse a raw JSON string into a validated InboundMessage.
 * Returns the message or null if malformed, missing fields, or unknown type.
 */
export function parseMessage(raw: string): InboundMessage | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!isRecord(parsed)) return null;

	switch (parsed.type) {
		case "prompt":
			return parsePromptMessage(parsed);
		default:
			return null;
	}
}

/** Serialize an outbound event for sending over the socket. */
export function serializeEvent(event: OutboundEvent): string {
	return JSON.stringify(event) + FRAME_DELIMITER;
}

// ---------------------------------------------------------------------------
// Internal validators
// ---------------------------------------------------------------------------

function parsePromptMessage(obj: Record<string, unknown>): PromptMessage | null {
	if (typeof obj.text !== "string") return null;
	if (!isRecord(obj.context)) return null;

	const ctx = obj.context;
	if (typeof ctx.file !== "string") return null;
	if (typeof ctx.cwd !== "string") return null;
	if (ctx.mode !== "normal" && ctx.mode !== "visual") return null;

	const context: PromptMessage["context"] = {
		file: ctx.file,
		cwd: ctx.cwd,
		mode: ctx.mode,
	};

	if (typeof ctx.filetype === "string") context.filetype = ctx.filetype;

	const VALID_BUFFER_STATES = new Set([
		"nameless",
		"scratch",
		"unsaved",
		"modified",
		"saved",
	] as const);
	type BufferState = (typeof VALID_BUFFER_STATES extends Set<infer T> ? T : never);
	if (typeof ctx.buffer_state === "string") {
		const state = ctx.buffer_state as BufferState;
		if (VALID_BUFFER_STATES.has(state)) {
			context.buffer_state = state;
		}
	}

	return { type: "prompt", text: obj.text, context };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
