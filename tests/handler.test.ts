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

	it("includes visual selection content in fenced block", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", content: "selected text", mode: "visual" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("```");
		expect(call).toContain("selected text");
	});

	it("marks visual mode in formatted message", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", content: "selected text", mode: "visual" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("Visual selection");
	});

	it("omits visual marker in normal mode", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt());
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).not.toContain("Visual selection");
	});

	it("handles empty file path gracefully", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "", cwd: "/c", mode: "normal" } }));
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).not.toContain("File:");
	});

	it("includes cursor position on file line", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f.ts", cwd: "/c", mode: "normal", cursor: { line: 42, col: 8 } } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("File: /f.ts (line 42, col 8)");
	});

	it("includes language when filetype is provided", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f.ts", cwd: "/c", mode: "normal", filetype: "typescript" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("Language: typescript");
	});

	it("includes current line in normal mode", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", mode: "normal", current_line: "local x = 1" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("Current line: `local x = 1`");
	});

	it("includes surrounding code in normal mode", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", mode: "normal", surrounding: "line1\nline2" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("Surrounding code:");
		expect(call).toContain("line1\nline2");
	});

	it("prefers content over surrounding when both present", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt({ context: { file: "/f", cwd: "/c", mode: "visual", content: "selection", surrounding: "surround" } }));
		const call = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(call).toContain("selection");
		expect(call).not.toContain("Surrounding code:");
	});
});
