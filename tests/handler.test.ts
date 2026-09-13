import { describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/handler.js";
import type {
	ApprovalAckMessage,
	ApprovalResponseMessage,
	PromptMessage,
} from "../src/protocol.js";

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
			buffer_state: "saved",
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
			makePrompt({
				context: { file: "src/main.ts", cwd: "/c", mode: "normal" },
			}),
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
				context: {
					file: "/f.ts",
					cwd: "/c",
					mode: "normal",
					filetype: "ts",
					buffer_state: "saved",
				},
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
				context: {
					file: "/home/user/src/utils.ts",
					cwd: "/c",
					mode: "visual",
					buffer_state: "saved",
				},
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"File: [utils.ts](/home/user/src/utils.ts)\n\nexplain",
		);
	});

	it("shows scratch hint when buffer_state is scratch", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				context: {
					file: "/tmp/scratch-123.lua",
					cwd: "/c",
					mode: "normal",
					buffer_state: "scratch",
				},
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const sent = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(sent).toContain("ephemeral scratch copy");
		expect(sent).toContain("fix this");
		expect(sent).not.toContain("File:");
	});

	it("shows modified hint when buffer_state is modified", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				context: {
					file: "/home/user/src/main.ts",
					cwd: "/c",
					mode: "normal",
					buffer_state: "modified",
				},
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const sent = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(sent).toContain("unsaved changes");
		expect(sent).toContain("fix this");
	});

	it("shows unsaved hint when buffer_state is unsaved", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				context: {
					file: "/home/user/src/main.ts",
					cwd: "/c",
					mode: "normal",
					buffer_state: "unsaved",
				},
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const sent = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(sent).toContain("unsaved in Neovim");
		expect(sent).toContain("fix this");
	});

	it("shows unsaved hint when buffer_state is nameless", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				context: {
					file: "",
					cwd: "/c",
					mode: "normal",
					buffer_state: "nameless",
				},
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const sent = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(sent).toContain("unsaved in Neovim");
	});

	it("shows file link when buffer_state is saved", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				context: {
					file: "/home/user/src/main.ts",
					cwd: "/c",
					mode: "normal",
					buffer_state: "saved",
				},
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			"File: [main.ts](/home/user/src/main.ts)\n\nfix this",
		);
	});

	it("falls back to existsSync when buffer_state is absent", () => {
		const pi = mockPi();
		handleMessage(
			pi,
			makePrompt({
				context: {
					file: "/tmp/definitely-does-not-exist-xyz.ts",
					cwd: "/c",
					mode: "normal",
				},
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledOnce();
		const sent = pi.sendUserMessage.mock.calls[0][0] as string;
		expect(sent).toContain("does not exist on disk");
	});
});

// ---------------------------------------------------------------------------
// Approval ack / response routing
// ---------------------------------------------------------------------------

/**
 * A gate is reachable via globalThis on the bridge side (see `src/handler.ts`).
 * Tests install a stub there before exercising `handleMessage`.
 */
import type { Gate } from "../src/approval.js";

const globalScope = globalThis as typeof globalThis & {
	__piBridgeGate?: Gate | null;
};

function installGate(): { gate: Gate; restore: () => void } {
	const gate = {
		requestApproval: vi.fn(),
		handleAck: vi.fn(),
		handleResponse: vi.fn(),
		handleCancel: vi.fn(),
		handleDisconnect: vi.fn(),
		reset: vi.fn(),
	} as unknown as Gate;
	const prev = globalScope.__piBridgeGate;
	globalScope.__piBridgeGate = gate;
	return { gate, restore: () => (globalScope.__piBridgeGate = prev ?? null) };
}

describe("handleMessage — approval messages", () => {
	it("routes approval_ack to gate.handleAck", () => {
		const { gate, restore } = installGate();
		try {
			const msg: ApprovalAckMessage = { type: "approval_ack", id: "abc" };
			handleMessage(mockPi(), msg);
			expect(gate.handleAck).toHaveBeenCalledWith("abc");
			expect(gate.handleResponse).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("routes approval_response to gate.handleResponse with the decision", () => {
		const { gate, restore } = installGate();
		try {
			const msg: ApprovalResponseMessage = {
				type: "approval_response",
				id: "xyz",
				decision: "all",
			};
			handleMessage(mockPi(), msg);
			expect(gate.handleResponse).toHaveBeenCalledWith("xyz", "all");
			expect(gate.handleAck).not.toHaveBeenCalled();
		} finally {
			restore();
		}
	});

	it("is a noop when no gate is installed (early message)", () => {
		const prev = globalScope.__piBridgeGate;
		globalScope.__piBridgeGate = null;
		try {
			expect(() =>
				handleMessage(mockPi(), { type: "approval_ack", id: "x" }),
			).not.toThrow();
			expect(() =>
				handleMessage(mockPi(), {
					type: "approval_response",
					id: "x",
					decision: "yes",
				}),
			).not.toThrow();
		} finally {
			globalScope.__piBridgeGate = prev ?? null;
		}
	});
});
