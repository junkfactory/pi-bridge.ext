import { describe, expect, it } from "vitest";
import { buildStartMessage } from "../src/index.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

function mockCtx(overrides?: Partial<ExtensionContext>): ExtensionContext {
	return {
		model: { name: "Claude", id: "claude-sonnet-4" },
		thinkingLevel: "medium",
		getContextUsage: () => ({ percent: 50 }),
		...overrides,
	} as unknown as ExtensionContext;
}

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
