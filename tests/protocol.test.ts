import { describe, expect, it } from "vitest";
import {
	frameBuffer,
	parseMessage,
	serializeEvent,
	FRAME_DELIMITER,
} from "../src/protocol.js";
import type { OutboundEvent, PromptMessage } from "../src/protocol.js";

// ---------------------------------------------------------------------------
// parseMessage
// ---------------------------------------------------------------------------

describe("parseMessage", () => {
	const validPrompt: PromptMessage = {
		type: "prompt",
		text: "fix this",
		context: {
			file: "/home/user/src/main.ts",
			cwd: "/home/user",
			mode: "normal",
		},
	};

	it("parses a valid prompt message", () => {
		const msg = parseMessage(JSON.stringify(validPrompt));
		expect(msg).toEqual(validPrompt);
	});

	it("parses prompt with visual mode", () => {
		const msg = parseMessage(
			JSON.stringify({ ...validPrompt, context: { ...validPrompt.context, mode: "visual" } }),
		);
		expect(msg?.type).toBe("prompt");
		if (msg?.type === "prompt") {
			expect(msg.context.mode).toBe("visual");
		}
	});

	it("returns null for invalid JSON", () => {
		expect(parseMessage("not json")).toBeNull();
	});

	it("returns null for unknown message type", () => {
		expect(parseMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
	});

	it("returns null for missing type field", () => {
		expect(parseMessage(JSON.stringify({ text: "hello" }))).toBeNull();
	});

	it("returns null for non-object input", () => {
		expect(parseMessage('"string"')).toBeNull();
		expect(parseMessage("42")).toBeNull();
		expect(parseMessage("null")).toBeNull();
		expect(parseMessage("[]")).toBeNull();
	});

	it("returns null for prompt missing text", () => {
		expect(
			parseMessage(JSON.stringify({ type: "prompt", context: validPrompt.context })),
		).toBeNull();
	});

	it("returns null for prompt missing context", () => {
		expect(parseMessage(JSON.stringify({ type: "prompt", text: "hi" }))).toBeNull();
	});

	it("returns null for prompt with missing required context fields", () => {
		const cases = [
			{ cwd: "/home/user", mode: "normal" }, // missing file
			{ file: "/f", mode: "normal" }, // missing cwd
			{ file: "/f", cwd: "/h" }, // missing mode
		];
		for (const ctx of cases) {
			expect(parseMessage(JSON.stringify({ type: "prompt", text: "hi", context: ctx }))).toBeNull();
		}
	});

	it("returns null for invalid mode value", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "prompt",
					text: "hi",
					context: { ...validPrompt.context, mode: "block" },
				}),
			),
		).toBeNull();
	});

	it("parses prompt with filetype only", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "prompt",
				text: "hi",
				context: { file: "/f.ts", cwd: "/", mode: "normal", filetype: "typescript" },
			}),
		);
		expect(msg).toEqual({
			type: "prompt",
			text: "hi",
			context: { file: "/f.ts", cwd: "/", mode: "normal", filetype: "typescript" },
		});
	});

	it("ignores invalid filetype", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "prompt",
				text: "hi",
				context: { ...validPrompt.context, filetype: 42 },
			}),
		);
		expect(msg).not.toBeNull();
		if (msg?.type === "prompt") {
			expect(msg.context.filetype).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// serializeEvent
// ---------------------------------------------------------------------------

describe("serializeEvent", () => {
	it("produces newline-terminated JSON", () => {
		const event: OutboundEvent = {
			type: "event",
			event: "agent_end",
			data: { summary: "done" },
		};
		const raw = serializeEvent(event);
		expect(raw.endsWith(FRAME_DELIMITER)).toBe(true);
		const parsed = JSON.parse(raw.trim());
		expect(parsed).toEqual(event);
	});

	it("round-trips through parseMessage is not applicable (different direction)", () => {
		// Outbound events are not inbound messages — just verify serialization
		const event: OutboundEvent = {
			type: "event",
			event: "tool_start",
			data: { tool: "bash" },
		};
		const raw = serializeEvent(event);
		expect(JSON.parse(raw.trim())).toEqual(event);
	});
});

// ---------------------------------------------------------------------------
// frameBuffer
// ---------------------------------------------------------------------------

describe("frameBuffer", () => {
	it("splits complete messages", () => {
		const buf = '{"a":1}\n{"b":2}\n';
		const { messages, remainder } = frameBuffer(buf);
		expect(messages).toEqual(['{"a":1}', '{"b":2}']);
		expect(remainder).toBe("");
	});

	it("handles buffer without trailing newline", () => {
		const buf = '{"a":1}\n{"b":2}';
		const { messages, remainder } = frameBuffer(buf);
		expect(messages).toEqual(['{"a":1}']);
		expect(remainder).toBe('{"b":2}');
	});

	it("handles empty buffer", () => {
		const { messages, remainder } = frameBuffer("");
		expect(messages).toEqual([]);
		expect(remainder).toBe("");
	});

	it("handles single partial message", () => {
		const { messages, remainder } = frameBuffer('{"partial":');
		expect(messages).toEqual([]);
		expect(remainder).toBe('{"partial":');
	});

	it("filters empty segments", () => {
		const buf = '{"a":1}\n\n{"b":2}\n';
		const { messages } = frameBuffer(buf);
		expect(messages).toEqual(['{"a":1}', '{"b":2}']);
	});

	it("handles multiple messages in one chunk", () => {
		const msg1 = JSON.stringify({ type: "prompt", text: "a", context: { file: "/f", cwd: "/c", mode: "normal" } });
		const msg2 = JSON.stringify({ type: "prompt", text: "b", context: { file: "/f", cwd: "/c", content: "y", mode: "visual" } });
		const buf = msg1 + "\n" + msg2 + "\n";
		const { messages, remainder } = frameBuffer(buf);
		expect(messages).toHaveLength(2);
		expect(remainder).toBe("");
	});
});
