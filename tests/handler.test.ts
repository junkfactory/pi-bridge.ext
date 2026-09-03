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
	it("prepends file link when context.file is absolute", () => {
		const pi = mockPi();
		handleMessage(pi, makePrompt());
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"File: [main.ts](/home/user/src/main.ts)\n\nfix this",
		);
	});

	it("sends only the text when file is empty", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({ context: { file: "", cwd: "/c", mode: "normal" } }),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("fix this");
	});

	it("sends only the text when file is relative", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({ context: { file: "src/main.ts", cwd: "/c", mode: "normal" } }),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith("fix this");
	});

	it("includes file link with filetype present", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "hello",
				context: { file: "/f.ts", cwd: "/c", mode: "normal", filetype: "ts" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"File: [f.ts](/f.ts)\n\nhello",
		);
	});

	it("includes file link in visual mode", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				text: "explain",
				context: { file: "/home/user/src/utils.ts", cwd: "/c", mode: "visual" },
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"File: [utils.ts](/home/user/src/utils.ts)\n\nexplain",
		);
	});
});
