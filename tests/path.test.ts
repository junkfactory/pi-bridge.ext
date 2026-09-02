import { describe, expect, it } from "vitest";
import { hashCwd, socketPath } from "../src/path.js";

describe("hashCwd", () => {
	it("returns 64-char hex string", () => {
		const hash = hashCwd("/home/user/project");
		expect(hash).toHaveLength(64);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is deterministic", () => {
		const a = hashCwd("/home/user/project");
		const b = hashCwd("/home/user/project");
		expect(a).toBe(b);
	});

	it("differs for different cwds", () => {
		const a = hashCwd("/home/user/project-a");
		const b = hashCwd("/home/user/project-b");
		expect(a).not.toBe(b);
	});
});

describe("socketPath", () => {
	it("contains the hash in the path", () => {
		const path = socketPath("/home/user/project");
		const hash = hashCwd("/home/user/project");
		expect(path).toContain(hash);
		expect(path.endsWith(".sock")).toBe(true);
	});
});
