import { describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/handler.js";
import type { PromptMessage } from "../src/protocol.js";

function mockPi() {
	return {
		sendUserMessage: vi.fn(),
	} as any;
}

function makePrompt(overrides?: Partial<PromptMessage>): PromptMessage {
	return {
		type: "prompt",
		text: "fix this",
		context: {
			file: "/home/user/src/main.ts",
			cwd: "/home/user",
			mode: "normal",
		},
		...overrides,
	};
}

describe("handleMessage", () => {
	it("dispatches prompt to sendUserMessage", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt());
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("fix this");
	});

	it("sends user text directly", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ text: "hello" }));
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("hello");
	});

	it("sends the message text verbatim", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ text: "add error handling" }));
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("add error handling");
	});

	it("ignores context fields and sends only text", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "hello",
				context: { file: "/f", cwd: "/c", mode: "normal", filetype: "ts" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("hello");
	});

	it("sends text for visual mode", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "explain",
				context: { file: "/f", cwd: "/c", mode: "visual" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("explain");
	});

	it("sends text even when file path is empty", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "still works",
				context: { file: "", cwd: "/c", mode: "normal" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("still works");
	});

	it("ignores cursor in context", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "go",
				context: { file: "/f.ts", cwd: "/c", mode: "normal", cursor: { line: 42, col: 8 } },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("go");
	});

	it("ignores content selection in context", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "review",
				context: { file: "/f", cwd: "/c", content: "selected text", mode: "visual" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("review");
	});

	it("ignores surrounding code in context", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "fix",
				context: { file: "/f", cwd: "/c", mode: "normal", surrounding: "line1\nline2" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("fix");
	});

	it("ignores current_line in context", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "why",
				context: { file: "/f", cwd: "/c", mode: "normal", current_line: "local x = 1" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("why");
	});

	it("ignores filetype in context", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "ok",
				context: { file: "/f.ts", cwd: "/c", mode: "normal", filetype: "typescript" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("ok");
	});
});