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
export type InboundMessage =
	| PromptMessage
	| ApprovalAckMessage
	| ApprovalResponseMessage
	| MirrorReadyMessage
	| UiPromptResponseMessage;

/** Neovim → pi: hello, sent on connect so pi-bridge knows the mirror is live. */
export interface MirrorReadyMessage {
	type: "mirror_ready";
}

/** Neovim → pi: answer for an outstanding ui_prompt_request.
 *  Exactly one of `value` / `cancelled` / `key` must be set:
 *    value     — picker answer for select/confirm (full original label)
 *    cancelled — picker was dismissed (Esc / close)
 *    key       — raw keypress to inject into a custom-mirror component */
export interface UiPromptResponseMessage {
	type: "ui_prompt_response";
	id: string;
	value?: string;
	cancelled?: boolean;
	key?: string;
}

/** Acknowledgement that Neovim rendered the approval prompt. */
export interface ApprovalAckMessage {
	type: "approval_ack";
	id: string;
}

/** User's decision on a pending approval request. */
export interface ApprovalResponseMessage {
	type: "approval_response";
	id: string;
	decision: "yes" | "all" | "no";
}

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
		range?: string;
	};
}

// ---------------------------------------------------------------------------
// Outbound messages (pi → Neovim)
// ---------------------------------------------------------------------------

/** Error codes for error events. */
export type ErrorCode = "stale_context" | "send_failed" | "no_active_pi";

/** Decision the extension may receive back from a pi fallback overlay. */
export type ApprovalDecision = "yes" | "all" | "no";

/** Edit/write tool whose diff is awaiting approval. */
export type ApprovalTool = "edit" | "write";

/** Outbound: a diff is awaiting user approval. */
export interface ApprovalRequestEvent {
	type: "approval_request";
	id: string;
	tool: ApprovalTool;
	path: string;
	diff: string;
}

/** Outbound: a previously broadcast approval_request has been settled
 *  (resolved by the user, by the pi fallback overlay, or by disconnect).
 *  Lets Neovim close any stale floating prompt. */
export interface ApprovalResolvedEvent {
	type: "approval_resolved";
	id: string;
}

/** pi → Neovim: a blocking prompt is awaiting user input.
 *  `kind`:
 *    select  — options picker; `title` + `options` set
 *    confirm — two-option picker (Yes/No); `title` + `options` set
 *    custom  — custom component mirror; `lines` set (rendered, ANSI present)
 *  Neovim answers via `ui_prompt_response`; either side may resolve first. */
export interface UiPromptRequestEvent {
	type: "ui_prompt_request";
	id: string;
	kind: "select" | "confirm" | "custom";
	title?: string;
	options?: string[];
	lines?: string[];
}

/** pi → Neovim: a previously broadcast ui_prompt_request has been settled.
 *  Sent exactly once per request; lets Neovim close any stale surface. */
export interface UiPromptResolvedEvent {
	type: "ui_prompt_resolved";
	id: string;
}

/** Event pushed to Neovim. */
export type OutboundEvent =
	| AgentLifecycleEvent
	| ErrorEvent
	| ApprovalRequestEvent
	| ApprovalResolvedEvent
	| UiPromptRequestEvent
	| UiPromptResolvedEvent;

export interface AgentLifecycleEvent {
	type: "agent_start" | "agent_end";
	message: string;
}

export interface ErrorEvent {
	type: "error";
	message: string;
	code?: ErrorCode;
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
		case "approval_ack":
			return parseApprovalAckMessage(parsed);
		case "approval_response":
			return parseApprovalResponseMessage(parsed);
		case "mirror_ready":
			return parseMirrorReadyMessage(parsed);
		case "ui_prompt_response":
			return parseUiPromptResponseMessage(parsed);
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

function parsePromptMessage(
	obj: Record<string, unknown>,
): PromptMessage | null {
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
	type BufferState =
		typeof VALID_BUFFER_STATES extends Set<infer T> ? T : never;
	if (typeof ctx.buffer_state === "string") {
		const state = ctx.buffer_state as BufferState;
		if (VALID_BUFFER_STATES.has(state)) {
			context.buffer_state = state;
		}
	}

	if (
		typeof ctx.range === "string" &&
		/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(ctx.range)
	) {
		context.range = ctx.range;
	}

	return { type: "prompt", text: obj.text, context };
}

function parseApprovalAckMessage(
	obj: Record<string, unknown>,
): ApprovalAckMessage | null {
	if (typeof obj.id !== "string" || obj.id.length === 0) return null;
	return { type: "approval_ack", id: obj.id };
}

function parseApprovalResponseMessage(
	obj: Record<string, unknown>,
): ApprovalResponseMessage | null {
	if (typeof obj.id !== "string" || obj.id.length === 0) return null;
	if (
		obj.decision !== "yes" &&
		obj.decision !== "all" &&
		obj.decision !== "no"
	) {
		return null;
	}
	return { type: "approval_response", id: obj.id, decision: obj.decision };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMirrorReadyMessage(
	_obj: Record<string, unknown>,
): MirrorReadyMessage | null {
	return { type: "mirror_ready" };
}

function parseUiPromptResponseMessage(
	obj: Record<string, unknown>,
): UiPromptResponseMessage | null {
	if (typeof obj.id !== "string" || obj.id.length === 0) return null;

	const hasValue = obj.value !== undefined;
	const hasCancelled = obj.cancelled !== undefined;
	const hasKey = obj.key !== undefined;
	const setCount =
		(hasValue ? 1 : 0) + (hasCancelled ? 1 : 0) + (hasKey ? 1 : 0);
	if (setCount !== 1) return null;

	const msg: UiPromptResponseMessage = {
		type: "ui_prompt_response",
		id: obj.id,
	};
	if (hasValue) {
		if (typeof obj.value !== "string") return null;
		msg.value = obj.value;
	} else if (hasCancelled) {
		if (typeof obj.cancelled !== "boolean") return null;
		msg.cancelled = obj.cancelled;
	} else {
		if (typeof obj.key !== "string") return null;
		msg.key = obj.key;
	}
	return msg;
}
