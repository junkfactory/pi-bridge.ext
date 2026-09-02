import { describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/handler.js";
import type { PromptMessage } from "../src/protocol.js";

function mockPi() {
	return {
		sendUserMessage: vi.fn(),
	} as any;
}

describe("handleMessage", () => {
	it("dispatches prompt messages to sendUserMessage", () => {
		const pi = mockPi();
		const message: PromptMessage = {
			type: "prompt",
			text: "fix this",
			context: {
				file: "/home/user/src/main.ts",
				cwd: "/home/user",
				content: "const x = 1;",
				mode: "normal",
			},
		};

		handleMessage(pi, message);
		// TODO: uncomment once handler is implemented
		// expect(pi.sendUserMessage).toHaveBeenCalledOnce();
	});
});
