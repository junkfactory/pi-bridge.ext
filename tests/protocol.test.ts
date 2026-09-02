import { describe, expect, it } from "vitest";
import { parseMessage, serializeEvent } from "../src/protocol.js";
import type { OutboundEvent } from "../src/protocol.js";

describe("parseMessage", () => {
	it("parses a valid prompt message", () => {
		const raw = JSON.stringify({
			type: "prompt",
			text: "fix this",
			context: {
				file: "/home/user/src/main.ts",
				cwd: "/home/user",
				content: "const x = 1;",
				mode: "normal",
			},
		});
		const msg = parseMessage(raw);
		expect(msg).not.toBeNull();
		expect(msg?.type).toBe("prompt");
	});

	it("returns null for invalid JSON", () => {
		expect(parseMessage("not json")).toBeNull();
	});

	it("returns null for unknown message type", () => {
		const raw = JSON.stringify({ type: "unknown" });
		expect(parseMessage(raw)).toBeNull();
	});

	it("returns null for missing required fields", () => {
		const raw = JSON.stringify({ type: "prompt" });
		expect(parseMessage(raw)).toBeNull();
	});
});

describe("serializeEvent", () => {
	it("produces valid JSON", () => {
		const event: OutboundEvent = {
			type: "event",
			event: "agent_end",
			data: { summary: "done" },
		};
		const raw = serializeEvent(event);
		expect(JSON.parse(raw)).toEqual(event);
	});
});
