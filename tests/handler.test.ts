import { describe, expect, it, vi } from "vitest";
import { handleMessage } from "../src/handler.js";
import type { Mirror, ResponsePayload } from "../src/prompt_mirror.js";
import { isMirrorReady } from "../src/prompt_mirror.js";
import type {
	ApprovalAckMessage,
	ApprovalResponseMessage,
	PromptMessage,
	UiPromptResponseMessage,
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

// ---------------------------------------------------------------------------
// Mirror messages — Step 4 wiring
// ---------------------------------------------------------------------------

/**
 * Mirror is reachable via globalThis (`__piBridgeMirror`). Tests install
 * a stub here so handleMessage can dispatch ui_prompt_response through
 * `getMirror()?.handleResponse(...)`. The stub records every call so
 * assertions verify the routing shape (id + ResponsePayload kind/value).
 */
const mirrorScope = globalThis as typeof globalThis & {
	__piBridgeMirror?: Mirror | null;
};

function installStubMirror(): {
	mirror: Mirror;
	restore: () => void;
} {
	const mirror = {
		isActive: vi.fn(),
		runSelect: vi.fn(),
		runConfirm: vi.fn(),
		runCustom: vi.fn(),
		handleResponse: vi.fn(),
		reset: vi.fn(),
	} as unknown as Mirror;
	const prev = mirrorScope.__piBridgeMirror;
	mirrorScope.__piBridgeMirror = mirror;
	return {
		mirror,
		restore: () => (mirrorScope.__piBridgeMirror = prev ?? null),
	};
}

describe("handleMessage — mirror_ready", () => {
	it("sets the mirror ready flag to true", () => {
		const prevReady = isMirrorReady();
		try {
			expect(isMirrorReady()).toBe(false);
			handleMessage(mockPi(), { type: "mirror_ready" });
			expect(isMirrorReady()).toBe(true);
		} finally {
			// Restore for downstream tests.
			if (!prevReady) {
				(
					mirrorScope as { __piBridgeMirrorReady?: boolean }
				).__piBridgeMirrorReady = false;
			}
		}
	});

	it("is idempotent — re-sent on reconnect keeps the flag true", () => {
		const prevReady = isMirrorReady();
		try {
			(
				mirrorScope as { __piBridgeMirrorReady?: boolean }
			).__piBridgeMirrorReady = true;
			handleMessage(mockPi(), { type: "mirror_ready" });
			expect(isMirrorReady()).toBe(true);
		} finally {
			if (!prevReady) {
				(
					mirrorScope as { __piBridgeMirrorReady?: boolean }
				).__piBridgeMirrorReady = false;
			}
		}
	});
});

describe("handleMessage — ui_prompt_response routing", () => {
	it("routes a value response to mirror.handleResponse with kind='value'", () => {
		const { mirror, restore } = installStubMirror();
		try {
			const msg: UiPromptResponseMessage = {
				type: "ui_prompt_response",
				id: "abc",
				value: "Option A",
			};
			handleMessage(mockPi(), msg);
			expect(mirror.handleResponse).toHaveBeenCalledWith("abc", {
				kind: "value",
				value: "Option A",
			});
		} finally {
			restore();
		}
	});

	it("routes a cancelled response to mirror.handleResponse with kind='cancelled'", () => {
		const { mirror, restore } = installStubMirror();
		try {
			const msg: UiPromptResponseMessage = {
				type: "ui_prompt_response",
				id: "abc",
				cancelled: true,
			};
			handleMessage(mockPi(), msg);
			expect(mirror.handleResponse).toHaveBeenCalledWith("abc", {
				kind: "cancelled",
			});
		} finally {
			restore();
		}
	});

	it("routes a key response to mirror.handleResponse with kind='key'", () => {
		const { mirror, restore } = installStubMirror();
		try {
			const msg: UiPromptResponseMessage = {
				type: "ui_prompt_response",
				id: "abc",
				key: "y",
			};
			handleMessage(mockPi(), msg);
			expect(mirror.handleResponse).toHaveBeenCalledWith("abc", {
				kind: "key",
				key: "y",
			});
		} finally {
			restore();
		}
	});

	it("forwards raw key bytes verbatim (escape form not normalized at the handler boundary)", () => {
		// The handler just routes; the mirror's handleResponse does the
		// escape-byte normalization. Verifying verbatim here locks in
		// the layering boundary.
		const { mirror, restore } = installStubMirror();
		try {
			const msg: UiPromptResponseMessage = {
				type: "ui_prompt_response",
				id: "k",
				key: "\x1b[27u",
			};
			handleMessage(mockPi(), msg);
			const payload = (mirror.handleResponse as ReturnType<typeof vi.fn>).mock
				.calls[0][1] as ResponsePayload;
			expect(payload).toEqual({ kind: "key", key: "\x1b[27u" });
		} finally {
			restore();
		}
	});

	it("is a noop when no mirror is installed (early message)", () => {
		const prev = mirrorScope.__piBridgeMirror;
		mirrorScope.__piBridgeMirror = null;
		try {
			expect(() =>
				handleMessage(mockPi(), {
					type: "ui_prompt_response",
					id: "x",
					value: "anything",
				}),
			).not.toThrow();
		} finally {
			mirrorScope.__piBridgeMirror = prev ?? null;
		}
	});
});
