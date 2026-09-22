import { describe, expect, it } from "vitest";
import type { OutboundEvent, PromptMessage } from "../src/protocol.js";
import {
	FRAME_DELIMITER,
	frameBuffer,
	parseMessage,
	serializeEvent,
} from "../src/protocol.js";

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
			JSON.stringify({
				...validPrompt,
				context: { ...validPrompt.context, mode: "visual" },
			}),
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
			parseMessage(
				JSON.stringify({ type: "prompt", context: validPrompt.context }),
			),
		).toBeNull();
	});

	it("returns null for prompt missing context", () => {
		expect(
			parseMessage(JSON.stringify({ type: "prompt", text: "hi" })),
		).toBeNull();
	});

	it("returns null for prompt with missing required context fields", () => {
		const cases = [
			{ cwd: "/home/user", mode: "normal" }, // missing file
			{ file: "/f", mode: "normal" }, // missing cwd
			{ file: "/f", cwd: "/h" }, // missing mode
		];
		for (const ctx of cases) {
			expect(
				parseMessage(
					JSON.stringify({ type: "prompt", text: "hi", context: ctx }),
				),
			).toBeNull();
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
				context: {
					file: "/f.ts",
					cwd: "/",
					mode: "normal",
					filetype: "typescript",
				},
			}),
		);
		expect(msg).toEqual({
			type: "prompt",
			text: "hi",
			context: {
				file: "/f.ts",
				cwd: "/",
				mode: "normal",
				filetype: "typescript",
			},
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

	it("parses prompt with buffer_state", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "prompt",
				text: "hi",
				context: {
					file: "/f",
					cwd: "/c",
					mode: "normal",
					buffer_state: "scratch",
				},
			}),
		);
		expect(msg).not.toBeNull();
		if (msg?.type === "prompt") {
			expect(msg.context.buffer_state).toBe("scratch");
		}
	});

	it("drops invalid buffer_state values", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "prompt",
				text: "hi",
				context: {
					file: "/f",
					cwd: "/c",
					mode: "normal",
					buffer_state: "invalid",
				},
			}),
		);
		expect(msg).not.toBeNull();
		if (msg?.type === "prompt") {
			expect(msg.context.buffer_state).toBeUndefined();
		}
	});

	it("handles absent buffer_state (backward compat)", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "prompt",
				text: "hi",
				context: { file: "/f", cwd: "/c", mode: "normal" },
			}),
		);
		expect(msg).not.toBeNull();
		if (msg?.type === "prompt") {
			expect(msg.context.buffer_state).toBeUndefined();
		}
	});

	it("parses valid range strings", () => {
		const cases = ["25", "12-200", "25,40-45", "1,2-3,4,5-10"];
		for (const range of cases) {
			const msg = parseMessage(
				JSON.stringify({
					type: "prompt",
					text: "hi",
					context: { ...validPrompt.context, range },
				}),
			);
			expect(msg).not.toBeNull();
			if (msg?.type === "prompt") {
				expect(msg.context.range).toBe(range);
			}
		}
	});

	it("drops invalid range strings", () => {
		const cases = ["abc", "12-", "-5", "25 ", "25,", ",25", "25..30"];
		for (const range of cases) {
			const msg = parseMessage(
				JSON.stringify({
					type: "prompt",
					text: "hi",
					context: { ...validPrompt.context, range },
				}),
			);
			expect(msg).not.toBeNull();
			if (msg?.type === "prompt") {
				expect(msg.context.range).toBeUndefined();
			}
		}
	});

	it("drops range when it is not a string (e.g. number)", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "prompt",
				text: "hi",
				context: { ...validPrompt.context, range: 12 },
			}),
		);
		expect(msg).not.toBeNull();
		if (msg?.type === "prompt") {
			expect(msg.context.range).toBeUndefined();
		}
	});

	it("handles absent range (backward compat)", () => {
		const msg = parseMessage(JSON.stringify(validPrompt));
		expect(msg).not.toBeNull();
		if (msg?.type === "prompt") {
			expect(msg.context.range).toBeUndefined();
		}
	});
});

// ---------------------------------------------------------------------------
// approval_ack / approval_response
// ---------------------------------------------------------------------------

describe("parseMessage (approval messages)", () => {
	it("parses a valid approval_ack", () => {
		const msg = parseMessage(
			JSON.stringify({ type: "approval_ack", id: "abc-123" }),
		);
		expect(msg).toEqual({ type: "approval_ack", id: "abc-123" });
	});

	it("returns null for approval_ack missing id", () => {
		expect(parseMessage(JSON.stringify({ type: "approval_ack" }))).toBeNull();
	});

	it("returns null for approval_ack with non-string id", () => {
		expect(
			parseMessage(JSON.stringify({ type: "approval_ack", id: 42 })),
		).toBeNull();
	});

	it("returns null for approval_ack with empty id", () => {
		expect(
			parseMessage(JSON.stringify({ type: "approval_ack", id: "" })),
		).toBeNull();
	});

	it("parses a valid approval_response for each decision", () => {
		for (const decision of ["yes", "all", "no"] as const) {
			const msg = parseMessage(
				JSON.stringify({ type: "approval_response", id: "x", decision }),
			);
			expect(msg).toEqual({ type: "approval_response", id: "x", decision });
		}
	});

	it("returns null for approval_response missing id", () => {
		expect(
			parseMessage(
				JSON.stringify({ type: "approval_response", decision: "yes" }),
			),
		).toBeNull();
	});

	it("returns null for approval_response with non-string id", () => {
		expect(
			parseMessage(
				JSON.stringify({ type: "approval_response", id: 0, decision: "yes" }),
			),
		).toBeNull();
	});

	it("returns null for approval_response with empty id", () => {
		expect(
			parseMessage(
				JSON.stringify({ type: "approval_response", id: "", decision: "yes" }),
			),
		).toBeNull();
	});

	it("returns null for approval_response with unknown decision", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "approval_response",
					id: "x",
					decision: "maybe",
				}),
			),
		).toBeNull();
		expect(
			parseMessage(
				JSON.stringify({ type: "approval_response", id: "x", decision: 1 }),
			),
		).toBeNull();
	});

	it("returns null for approval_response missing decision", () => {
		expect(
			parseMessage(JSON.stringify({ type: "approval_response", id: "x" })),
		).toBeNull();
	});
});

describe("serializeEvent (approval events)", () => {
	it("serializes approval_request and approval_resolved", () => {
		const req = {
			type: "approval_request" as const,
			id: "abc",
			tool: "edit" as const,
			path: "/tmp/foo.ts",
			diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n",
		};
		const raw = serializeEvent(req);
		expect(raw.endsWith(FRAME_DELIMITER)).toBe(true);
		expect(JSON.parse(raw.trim())).toEqual(req);

		const res = {
			type: "approval_resolved" as const,
			id: "abc",
		};
		const raw2 = serializeEvent(res);
		expect(raw2.endsWith(FRAME_DELIMITER)).toBe(true);
		expect(JSON.parse(raw2.trim())).toEqual(res);
	});
});

// ---------------------------------------------------------------------------
// mirror_ready
// ---------------------------------------------------------------------------

describe("parseMessage (mirror_ready)", () => {
	it("parses a valid mirror_ready", () => {
		const msg = parseMessage(JSON.stringify({ type: "mirror_ready" }));
		expect(msg).toEqual({ type: "mirror_ready" });
	});
});

// ---------------------------------------------------------------------------
// ui_prompt_response
// ---------------------------------------------------------------------------

describe("parseMessage (ui_prompt_response)", () => {
	it("parses a response with value", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "ui_prompt_response",
				id: "abc",
				value: "Yes",
			}),
		);
		expect(msg).toEqual({
			type: "ui_prompt_response",
			id: "abc",
			value: "Yes",
		});
	});

	it("parses a response with cancelled", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "ui_prompt_response",
				id: "abc",
				cancelled: true,
			}),
		);
		expect(msg).toEqual({
			type: "ui_prompt_response",
			id: "abc",
			cancelled: true,
		});
	});

	it("parses a response with key", () => {
		const msg = parseMessage(
			JSON.stringify({
				type: "ui_prompt_response",
				id: "abc",
				key: "y",
			}),
		);
		expect(msg).toEqual({ type: "ui_prompt_response", id: "abc", key: "y" });
	});

	it("returns null for ui_prompt_response missing id", () => {
		expect(
			parseMessage(
				JSON.stringify({ type: "ui_prompt_response", value: "Yes" }),
			),
		).toBeNull();
	});

	it("returns null for ui_prompt_response with empty id", () => {
		expect(
			parseMessage(
				JSON.stringify({ type: "ui_prompt_response", id: "", value: "Yes" }),
			),
		).toBeNull();
	});

	it("returns null for ui_prompt_response with non-string id", () => {
		expect(
			parseMessage(
				JSON.stringify({ type: "ui_prompt_response", id: 1, value: "Yes" }),
			),
		).toBeNull();
	});

	it("returns null when none of value/cancelled/key is set", () => {
		expect(
			parseMessage(JSON.stringify({ type: "ui_prompt_response", id: "abc" })),
		).toBeNull();
	});

	it("returns null when value and cancelled are both set", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "ui_prompt_response",
					id: "abc",
					value: "Yes",
					cancelled: true,
				}),
			),
		).toBeNull();
	});

	it("returns null when value and key are both set", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "ui_prompt_response",
					id: "abc",
					value: "Yes",
					key: "y",
				}),
			),
		).toBeNull();
	});

	it("returns null when cancelled and key are both set", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "ui_prompt_response",
					id: "abc",
					cancelled: true,
					key: "y",
				}),
			),
		).toBeNull();
	});

	it("returns null when all three are set", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "ui_prompt_response",
					id: "abc",
					value: "Yes",
					cancelled: true,
					key: "y",
				}),
			),
		).toBeNull();
	});

	it("returns null when value is non-string", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "ui_prompt_response",
					id: "abc",
					value: 42,
				}),
			),
		).toBeNull();
	});

	it("returns null when cancelled is non-boolean", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "ui_prompt_response",
					id: "abc",
					cancelled: "yes",
				}),
			),
		).toBeNull();
	});

	it("returns null when key is non-string", () => {
		expect(
			parseMessage(
				JSON.stringify({
					type: "ui_prompt_response",
					id: "abc",
					key: 1,
				}),
			),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// ui_prompt_request / ui_prompt_resolved (outbound events)
// ---------------------------------------------------------------------------

describe("serializeEvent (ui_prompt events)", () => {
	it("serializes ui_prompt_request with select kind", () => {
		const req = {
			type: "ui_prompt_request" as const,
			id: "abc",
			kind: "select" as const,
			title: "Pick one",
			options: ["Yes", "No"],
		};
		const raw = serializeEvent(req);
		expect(raw.endsWith(FRAME_DELIMITER)).toBe(true);
		expect(JSON.parse(raw.trim())).toEqual(req);
	});

	it("serializes ui_prompt_request with confirm kind", () => {
		const req = {
			type: "ui_prompt_request" as const,
			id: "abc",
			kind: "confirm" as const,
			title: "Proceed?",
			options: ["Yes", "No"],
		};
		const raw = serializeEvent(req);
		expect(raw.endsWith(FRAME_DELIMITER)).toBe(true);
		expect(JSON.parse(raw.trim())).toEqual(req);
	});

	it("serializes ui_prompt_request with custom kind", () => {
		const req = {
			type: "ui_prompt_request" as const,
			id: "abc",
			kind: "custom" as const,
			lines: ["hello", "world"],
		};
		const raw = serializeEvent(req);
		expect(raw.endsWith(FRAME_DELIMITER)).toBe(true);
		expect(JSON.parse(raw.trim())).toEqual(req);
	});

	it("serializes ui_prompt_resolved", () => {
		const res = { type: "ui_prompt_resolved" as const, id: "abc" };
		const raw = serializeEvent(res);
		expect(raw.endsWith(FRAME_DELIMITER)).toBe(true);
		expect(JSON.parse(raw.trim())).toEqual(res);
	});

	it("preserves optional fields when omitted", () => {
		const req = {
			type: "ui_prompt_request" as const,
			id: "abc",
			kind: "select" as const,
		};
		const raw = serializeEvent(req);
		const parsed = JSON.parse(raw.trim());
		expect(parsed).toEqual(req);
		expect(parsed.title).toBeUndefined();
		expect(parsed.options).toBeUndefined();
		expect(parsed.lines).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// serializeEvent
// ---------------------------------------------------------------------------

describe("serializeEvent", () => {
	it("produces newline-terminated JSON", () => {
		const event: OutboundEvent = {
			type: "agent_end",
			message: "done",
		};
		const raw = serializeEvent(event);
		expect(raw.endsWith(FRAME_DELIMITER)).toBe(true);
		const parsed = JSON.parse(raw.trim());
		expect(parsed).toEqual(event);
	});

	it("round-trips through parseMessage is not applicable (different direction)", () => {
		// Outbound events are not inbound messages — just verify serialization
		const event: OutboundEvent = {
			type: "agent_start",
			message: "working...",
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
		const msg1 = JSON.stringify({
			type: "prompt",
			text: "a",
			context: { file: "/f", cwd: "/c", mode: "normal" },
		});
		const msg2 = JSON.stringify({
			type: "prompt",
			text: "b",
			context: { file: "/f", cwd: "/c", content: "y", mode: "visual" },
		});
		const buf = `${msg1}\n${msg2}\n`;
		const { messages, remainder } = frameBuffer(buf);
		expect(messages).toHaveLength(2);
		expect(remainder).toBe("");
	});
});
