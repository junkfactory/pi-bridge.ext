import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildStartMessage, default as extension } from "../src/index.js";
import { start, stop } from "../src/socket.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

vi.mock("../src/socket.js", () => ({
	start: vi.fn(),
	stop: vi.fn(),
	broadcast: vi.fn(),
}));

vi.mock("../src/log.js", () => ({
	LOG_PATH: "/tmp/pi-bridge-test.log",
	setLogLevel: vi.fn(),
	trace: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../src/path.js", () => ({
	socketPath: vi.fn((cwd: string) => `/tmp/pi-bridge-test-sockets/${cwd.replace(/\//g, "_")}.sock`),
	ensureSocketDir: vi.fn(),
}));

function mockCtx(
	overrides?: Partial<ExtensionContext>,
	notify?: ReturnType<typeof vi.fn>,
): ExtensionContext {
	return {
		model: { name: "Claude", id: "claude-sonnet-4" },
		thinkingLevel: "medium",
		getContextUsage: () => ({ percent: 50 }),
		cwd: "/tmp/fake-project",
		ui: { notify: notify ?? vi.fn() },
		...overrides,
	} as unknown as ExtensionContext;
}

/** Register the extension and return its event handlers. */
function registerExtension(): Record<string, (event: any, ctx: ExtensionContext) => Promise<void> | void> {
	const handlers: Record<string, (event: any, ctx: ExtensionContext) => Promise<void> | void> = {};
	const pi = {
		on: vi.fn((event: string, handler: (event: any, ctx: ExtensionContext) => Promise<void> | void) => {
			handlers[event] = handler;
		}),
		sendUserMessage: vi.fn(),
	} as unknown as ExtensionAPI;
	extension(pi);
	return handlers;
}

beforeEach(() => {
	vi.mocked(start).mockReset().mockResolvedValue({ status: "started" });
	vi.mocked(stop).mockReset().mockResolvedValue(undefined);
});

describe("buildStartMessage", () => {
	it("includes model name and thinking level", () => {
		const msg = buildStartMessage(mockCtx());
		expect(msg).toBe("Claude is thinking in medium at 50.00% brain usage");
	});

	it("rounds brain usage to two decimal places", () => {
		const msg = buildStartMessage(mockCtx({ getContextUsage: () => ({ percent: 12.3456 }) }));
		expect(msg).toContain("at 12.35% brain usage");
	});

	it("falls back to model id when name is missing", () => {
		const msg = buildStartMessage(mockCtx({ model: { id: "claude-sonnet-4" } } as any));
		expect(msg).toContain("claude-sonnet-4");
	});

	it("uses 'agent' when model is undefined", () => {
		const msg = buildStartMessage(mockCtx({ model: undefined } as any));
		expect(msg).toContain("agent");
	});

	it("omits thinking level when undefined", () => {
		const msg = buildStartMessage(mockCtx({ thinkingLevel: undefined } as any));
		expect(msg).toBe("Claude is thinking at 50.00% brain usage");
	});

	it("treats 'off' thinking level as no thinking level", () => {
		const msg = buildStartMessage(mockCtx({ thinkingLevel: "off" }));
		expect(msg).toBe("Claude is thinking at 50.00% brain usage");
		expect(msg).not.toContain("in off");
	});

	it("includes valid thinking levels", () => {
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			const msg = buildStartMessage(mockCtx({ thinkingLevel: level }));
			expect(msg).toContain(`in ${level}`);
		}
	});

	it("omits brain usage when percent is null", () => {
		const msg = buildStartMessage(mockCtx({ getContextUsage: () => ({ percent: null }) } as any));
		expect(msg).not.toContain("brain usage");
	});

	it("omits brain usage when percent is 0", () => {
		const msg = buildStartMessage(mockCtx({ getContextUsage: () => ({ percent: 0 }) }));
		expect(msg).not.toContain("brain usage");
	});

	it("omits brain usage when getContextUsage returns undefined", () => {
		const msg = buildStartMessage(mockCtx({ getContextUsage: () => undefined }));
		expect(msg).not.toContain("brain usage");
	});
});

describe("extension socket lifecycle", () => {
	it("starts the socket on session_start", async () => {
		const handlers = registerExtension();
		await handlers.session_start({ type: "session_start", reason: "startup" }, mockCtx());

		expect(start).toHaveBeenCalledTimes(1);
		expect(stop).not.toHaveBeenCalled();
	});

	it("keeps the socket across session switches (new, resume, fork, reload)", async () => {
		const handlers = registerExtension();
		for (const reason of ["new", "resume", "fork", "reload"] as const) {
			await handlers.session_shutdown({ type: "session_shutdown", reason }, mockCtx());
		}
		expect(stop).not.toHaveBeenCalled();
	});

	it("stops the socket on quit", async () => {
		const handlers = registerExtension();
		await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, mockCtx());
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("notifies when another pi instance owns the socket", async () => {
		vi.mocked(start).mockResolvedValue({ status: "foreign-owner" });
		const notify = vi.fn();
		const handlers = registerExtension();

		await handlers.session_start({ type: "session_start", reason: "startup" }, mockCtx(undefined, notify));

		expect(notify).toHaveBeenCalledWith(
			"pi-bridge: another pi instance is running for this directory — pi-bridge not hosting this session",
			"warning",
		);
	});

	it("does not notify when hosting normally on startup", async () => {
		const notify = vi.fn();
		const handlers = registerExtension();

		await handlers.session_start({ type: "session_start", reason: "startup" }, mockCtx(undefined, notify));

		expect(notify).not.toHaveBeenCalled();
	});

	it("does not notify for already-hosted sessions after a switch", async () => {
		vi.mocked(start).mockResolvedValue({ status: "already-hosted" });
		const notify = vi.fn();
		const handlers = registerExtension();

		await handlers.session_start({ type: "session_start", reason: "new" }, mockCtx(undefined, notify));

		expect(notify).not.toHaveBeenCalled();
	});
});
