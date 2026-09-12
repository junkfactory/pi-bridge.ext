import { describe, expect, it, vi } from "vitest";
import { createGate } from "../src/approval.js";
import type { ApprovalTool } from "../src/protocol.js";

const TOOL: ApprovalTool = "edit";

function args(
	overrides?: Partial<
		Parameters<ReturnType<typeof createGate>["requestApproval"]>[0]
	>,
) {
	return {
		tool: TOOL,
		path: "/tmp/example.ts",
		diff: "--- a\n+++ b\n@@\n-x\n+y\n",
		signal: undefined,
		...overrides,
	};
}

/** Convenience: extract just the result from the new outcome shape. */
async function requestResult(gate: ReturnType<typeof createGate>, a = args()) {
	const { result } = await gate.requestApproval(a);
	return result;
}

describe("createGate — per-file memory", () => {
	it("remembers an 'all' decision for a file and resolves subsequent requests immediately", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		// Simulate an ack-then-response flow ending in "all". The first
		// request broadcasts after a microtask, so await the broadcast.
		const p1 = gate.requestApproval(args({ path: "/tmp/a.ts" }));
		await waitForCall(broadcast);
		const id = extractId(broadcast);
		gate.handleAck(id);
		gate.handleResponse(id, "all");
		expect((await p1).result).toBe("all");

		// Manually persist via settle() since `handleResponse` doesn't
		// know to remember the path; the caller (or test) does.
		gate.settle(id, "all", "/tmp/a.ts");

		// Subsequent request to the same path resolves immediately, without
		// broadcasting another approval_request.
		const before = broadcast.mock.calls.length;
		const r2 = await requestResult(gate, args({ path: "/tmp/a.ts" }));
		expect(r2).toBe("all");
		expect(broadcast.mock.calls.length).toBe(before);
	});

	it("does not remember 'yes' for a file", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p1 = gate.requestApproval(args({ path: "/tmp/b.ts" }));
		await waitForCall(broadcast);
		const id = extractId(broadcast);
		gate.handleAck(id);
		gate.handleResponse(id, "yes");
		expect((await p1).result).toBe("yes");

		// Next request still needs broadcast.
		const before = broadcast.mock.calls.length;
		const p2 = gate.requestApproval(args({ path: "/tmp/b.ts" }));
		await waitForCount(broadcast, before + 1);
		// Clean up so the test doesn't hang on the ack timer.
		const id2 = extractId(broadcast, before);
		gate.handleAck(id2);
		gate.handleResponse(id2, "no");
		expect((await p2).result).toBe("no");
	});

	it("memory is per-file — different files still prompt", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p1 = gate.requestApproval(args({ path: "/tmp/c.ts" }));
		await waitForCall(broadcast);
		const id1 = extractId(broadcast);
		gate.handleAck(id1);
		gate.handleResponse(id1, "all");
		expect((await p1).result).toBe("all");
		// Persist for memory.
		gate.settle(id1, "all", "/tmp/c.ts");

		const before = broadcast.mock.calls.length;
		const p2 = gate.requestApproval(args({ path: "/tmp/d.ts" }));
		await waitForCount(broadcast, before + 1);
		// Cleanup so the test doesn't hang on the timer.
		const id2 = extractId(broadcast, before);
		gate.handleAck(id2);
		gate.handleResponse(id2, "no");
		expect((await p2).result).toBe("no");
	});
});

describe("createGate — queue ordering", () => {
	it("serializes concurrent requests so they resolve in order", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 60_000 });

		const order: string[] = [];
		const p1 = gate.requestApproval(args({ path: "/tmp/q1.ts" })).then((o) => {
			order.push(`q1:${o.result}`);
			return o;
		});
		const p2 = gate.requestApproval(args({ path: "/tmp/q2.ts" })).then((o) => {
			order.push(`q2:${o.result}`);
			return o;
		});
		const p3 = gate.requestApproval(args({ path: "/tmp/q3.ts" })).then((o) => {
			order.push(`q3:${o.result}`);
			return o;
		});

		// Only q1 should have been broadcast so far — q2 and q3 are queued
		// behind p1 settling.
		await waitForCall(broadcast);
		expect(broadcast.mock.calls).toHaveLength(1);
		const req1 = JSON.parse(broadcast.mock.calls[0][0].trim());
		expect(req1.path).toBe("/tmp/q1.ts");
		gate.handleAck(req1.id);
		gate.handleResponse(req1.id, "yes");
		await p1;

		// Now q2 broadcasts.
		await waitForCount(broadcast, 2);
		const req2 = JSON.parse(broadcast.mock.calls[1][0].trim());
		expect(req2.path).toBe("/tmp/q2.ts");
		gate.handleAck(req2.id);
		gate.handleResponse(req2.id, "yes");
		await p2;

		// Now q3 broadcasts.
		await waitForCount(broadcast, 3);
		const req3 = JSON.parse(broadcast.mock.calls[2][0].trim());
		expect(req3.path).toBe("/tmp/q3.ts");
		gate.handleAck(req3.id);
		gate.handleResponse(req3.id, "yes");
		await p3;

		expect(order).toEqual(["q1:yes", "q2:yes", "q3:yes"]);
	});
});

describe("createGate — ack window", () => {
	it("waits indefinitely for a response after ack", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 30 });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		const id = extractId(broadcast);
		// Ack before the timeout elapses.
		await new Promise((r) => setTimeout(r, 10));
		gate.handleAck(id);

		// Wait much longer than the ack window: must NOT resolve.
		await new Promise((r) => setTimeout(r, 100));
		// Now send a response.
		gate.handleResponse(id, "yes");
		expect((await p).result).toBe("yes");
	});

	it("falls back when no ack arrives within the window", async () => {
		const broadcast = vi.fn();
		// Attach listener via a fresh instance so it sees the resolved id.
		const observed: string[] = [];
		const gate = createGate({
			broadcast,
			ackTimeoutMs: 20,
			onResolved: (id) => observed.push(id),
		});

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		expect((await p).result).toBe("fallback");
		// onResolved must have fired with the same id we broadcast.
		const id = JSON.parse(broadcast.mock.calls[0][0].trim()).id;
		expect(observed).toEqual([id]);
	});

	it("ignores a late response after the fallback has resolved", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 20 });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		expect((await p).result).toBe("fallback");

		// A late ack + response must not throw or change anything.
		const id = JSON.parse(broadcast.mock.calls[0][0].trim()).id;
		expect(() => gate.handleAck(id)).not.toThrow();
		expect(() => gate.handleResponse(id, "yes")).not.toThrow();
	});
});

describe("createGate — disconnect", () => {
	it("releases an unacked pending request to 'fallback' on disconnect", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 60_000 });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		const id = JSON.parse(broadcast.mock.calls[0][0].trim()).id;
		// No ack yet.
		gate.handleDisconnect();
		expect((await p).result).toBe("fallback");

		// Late ack/response after disconnect should be ignored (first wins).
		expect(() => gate.handleAck(id)).not.toThrow();
		expect(() => gate.handleResponse(id, "yes")).not.toThrow();
	});

	it("also releases an already-acked pending request on disconnect", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 60_000 });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		const id = JSON.parse(broadcast.mock.calls[0][0].trim()).id;
		gate.handleAck(id);
		gate.handleDisconnect();
		expect((await p).result).toBe("fallback");
	});

	it("is a noop when no request is pending", () => {
		const gate = createGate({ broadcast: vi.fn() });
		expect(() => gate.handleDisconnect()).not.toThrow();
	});
});

describe("createGate — reset", () => {
	it("clears the per-file approval memory", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p1 = gate.requestApproval(args({ path: "/tmp/r.ts" }));
		await waitForCall(broadcast);
		const id1 = extractId(broadcast);
		gate.handleAck(id1);
		gate.handleResponse(id1, "all");
		expect((await p1).result).toBe("all");
		gate.settle(id1, "all", "/tmp/r.ts");

		gate.reset();

		// Memory must be cleared — this one will broadcast.
		const before = broadcast.mock.calls.length;
		const p2 = gate.requestApproval(args({ path: "/tmp/r.ts" }));
		await waitForCount(broadcast, before + 1);

		// Cleanup so the timer doesn't keep this test alive.
		const id2 = JSON.parse(broadcast.mock.calls[before][0].trim()).id;
		gate.handleAck(id2);
		gate.handleResponse(id2, "no");
		expect((await p2).result).toBe("no");
	});

	it("cancels any in-flight pending request", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 60_000 });

		const p = gate.requestApproval(args());
		// Wait for the broadcast to happen (so we know runOne is active).
		await waitForCall(broadcast);
		gate.reset();
		expect((await p).result).toBe("cancelled");
	});
});

describe("createGate — signal abort", () => {
	it("cancels a pending request when the agent aborts before the ack", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 60_000 });

		const ac = new AbortController();
		const p = gate.requestApproval(args({ signal: ac.signal }));
		ac.abort();
		expect((await p).result).toBe("cancelled");
	});

	it("resolves immediately as cancelled when the signal is already aborted", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 60_000 });

		const ac = new AbortController();
		ac.abort();
		const p = gate.requestApproval(args({ signal: ac.signal }));
		expect((await p).result).toBe("cancelled");
	});
});

describe("createGate — settle", () => {
	it("records 'all' for the matching fallback and resolves subsequent requests immediately", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast, ackTimeoutMs: 20 });

		// Drive a fallback path: no ack, then settle with "all".
		const p1 = gate.requestApproval(args({ path: "/tmp/s.ts" }));
		await waitForCall(broadcast);
		const id = extractId(broadcast);
		expect((await p1).result).toBe("fallback");
		gate.settle(id, "all", "/tmp/s.ts");

		// The path is remembered; no broadcast for the next request.
		const before = broadcast.mock.calls.length;
		const r2 = await requestResult(gate, args({ path: "/tmp/s.ts" }));
		expect(r2).toBe("all");
		expect(broadcast.mock.calls.length).toBe(before);
	});

	it("ignores settle for unknown ids", () => {
		const _broadcast = vi.fn();
		const gate = createGate({ broadcast: vi.fn() });
		expect(() => gate.settle("not-an-id", "yes", "/tmp/x.ts")).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Pull the id out of the Nth broadcast call. Defaults to the last call.
 */
function extractId(broadcast: ReturnType<typeof vi.fn>, n?: number): string {
	const calls = broadcast.mock.calls;
	if (calls.length === 0) throw new Error("no broadcast call");
	const idx = n ?? calls.length - 1;
	const data = calls[idx][0] as string;
	return JSON.parse(data.trim()).id;
}

/** Wait until the broadcast mock has at least one call. */
function waitForCall(broadcast: ReturnType<typeof vi.fn>): Promise<void> {
	return new Promise((resolve) => {
		const check = () => {
			if (broadcast.mock.calls.length > 0) resolve();
			else setTimeout(check, 0);
		};
		check();
	});
}

/** Wait until the broadcast mock has at least `n` calls. */
function waitForCount(
	broadcast: ReturnType<typeof vi.fn>,
	n: number,
): Promise<void> {
	return new Promise((resolve) => {
		const check = () => {
			if (broadcast.mock.calls.length >= n) resolve();
			else setTimeout(check, 0);
		};
		check();
	});
}

describe("createGate — session reset", () => {
	it("short-circuits queued requests across a reset without broadcasting", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		// Two requests: r1 becomes pending, r2 queues behind it.
		const p1 = gate.requestApproval(args({ path: "/tmp/a.ts" }));
		const p2 = gate.requestApproval(args({ path: "/tmp/b.ts" }));
		await waitForCount(broadcast, 1);

		// Reset (session switch) while both are in flight: r1 resolves
		// cancelled, r2 short-circuits without broadcasting a new request.
		gate.reset();
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1.result).toBe("cancelled");
		expect(r2.result).toBe("cancelled");
		expect(r2.id).toBe("");
		expect(broadcast).toHaveBeenCalledTimes(1);
	});

	it("new requests after a reset broadcast normally", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });
		gate.reset();
		const p = gate.requestApproval(args({ path: "/tmp/c.ts" }));
		await waitForCall(broadcast);
		expect(broadcast).toHaveBeenCalledTimes(1);
		const id = extractId(broadcast);
		gate.handleAck(id);
		gate.handleResponse(id, "yes");
		expect((await p).result).toBe("yes");
	});
});
