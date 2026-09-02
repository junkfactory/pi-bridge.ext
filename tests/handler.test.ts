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
			content: "const x = 1;",
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
	});

	it("includes file path in formatted message", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt());
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("File: /home/user/src/main.ts");
	});

	it("includes user text in formatted message", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ text: "add error handling" }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("add error handling");
	});

	it("includes code content in fenced block", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", content: "const y = 2;", mode: "normal" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("```");
		expect(call).toContain("const y = 2;");
	});

	it("marks visual mode in formatted message", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", content: "selected text", mode: "visual" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("Visual selection");
	});

	it("omits visual marker in normal mode", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", content: "x", mode: "normal" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).not.toContain("Visual selection");
	});

	it("handles empty content gracefully", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", content: "", mode: "normal" } }));
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		// Should not have empty code fence
		expect(call).not.toMatch(/```\n```/);
	});

	it("handles empty file path gracefully", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "", cwd: "/c", content: "x", mode: "normal" } }));
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).not.toContain("File:");
	});
});
