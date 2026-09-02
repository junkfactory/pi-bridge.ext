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
	it("dispatches prompt with context to sendUserMessage", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt());
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"[file: /home/user/src/main.ts, cwd: /home/user, mode: normal] fix this",
		);
	});

	it("includes context header with text", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ text: "hello" }));
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"[file: /home/user/src/main.ts, cwd: /home/user, mode: normal] hello",
		);
	});

	it("includes filetype when present", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "hello",
				context: { file: "/f", cwd: "/c", mode: "normal", filetype: "ts" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"[file: /f, cwd: /c, mode: normal, filetype: ts] hello",
		);
	});

	it("includes visual mode in context", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "explain",
				context: { file: "/f", cwd: "/c", mode: "visual" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"[file: /f, cwd: /c, mode: visual] explain",
		);
	});

	it("sends context even when file path is empty", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "still works",
				context: { file: "", cwd: "/c", mode: "normal" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"[file: , cwd: /c, mode: normal] still works",
		);
	});
});
