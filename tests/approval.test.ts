/**
 * Tests for the approval gate state machine.
 *
 * Covers the redesign:
 *   - Per-file "all" memory
 *   - Queue serialization (first-wins from nvim OR the caller feeds a decision)
 *   - Response routing + late-answer discard
 *   - Session reset
 *   - Abort signal
 *   - handleDisconnect is a NO-OP (pi prompt stays open)
 *
 * The redesign removed: ack timer, fallback decision, settle(), onRequestStart.
 */

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

/** Convenience: extract just the result from the outcome shape. */
async function requestResult(gate: ReturnType<typeof createGate>, a = args()) {
	const { result } = await gate.requestApproval(a);
	return result;
}

describe("createGate — per-file memory", () => {
	it("remembers an 'all' decision for a file and resolves subsequent requests immediately", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p1 = gate.requestApproval(args({ path: "/tmp/a.ts" }));
		await waitForCall(broadcast);
		const id = extractId(broadcast);
		gate.handleResponse(id, "all");
		expect((await p1).result).toBe("all");

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
		gate.handleResponse(id, "yes");
		expect((await p1).result).toBe("yes");

		// Next request still needs broadcast.
		const before = broadcast.mock.calls.length;
		const p2 = gate.requestApproval(args({ path: "/tmp/b.ts" }));
		await waitForCount(broadcast, before + 1);
		const id2 = extractId(broadcast, before);
		gate.handleResponse(id2, "no");
		expect((await p2).result).toBe("no");
	});

	it("memory is per-file — different files still prompt", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p1 = gate.requestApproval(args({ path: "/tmp/c.ts" }));
		await waitForCall(broadcast);
		const id1 = extractId(broadcast);
		gate.handleResponse(id1, "all");
		expect((await p1).result).toBe("all");

		const before = broadcast.mock.calls.length;
		const p2 = gate.requestApproval(args({ path: "/tmp/d.ts" }));
		await waitForCount(broadcast, before + 1);
		const id2 = extractId(broadcast, before);
		gate.handleResponse(id2, "no");
		expect((await p2).result).toBe("no");
	});
});

describe("createGate — caller-supplied id", () => {
	it("uses the id passed in args instead of generating one", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });
		const customId = "caller-supplied-id-1234";
		const p = gate.requestApproval(args({ id: customId }));
		await waitForCall(broadcast);
		const broadcastId = JSON.parse(broadcast.mock.calls[0][0].trim()).id;
		expect(broadcastId).toBe(customId);
		gate.handleResponse(customId, "yes");
		expect((await p).id).toBe(customId);
		expect((await p).result).toBe("yes");
	});
});

describe("createGate — queue ordering", () => {
	it("serializes concurrent requests so they resolve in order", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

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
		gate.handleResponse(req1.id, "yes");
		await p1;

		// Now q2 broadcasts.
		await waitForCount(broadcast, 2);
		const req2 = JSON.parse(broadcast.mock.calls[1][0].trim());
		expect(req2.path).toBe("/tmp/q2.ts");
		gate.handleResponse(req2.id, "yes");
		await p2;

		// Now q3 broadcasts.
		await waitForCount(broadcast, 3);
		const req3 = JSON.parse(broadcast.mock.calls[2][0].trim());
		expect(req3.path).toBe("/tmp/q3.ts");
		gate.handleResponse(req3.id, "yes");
		await p3;

		expect(order).toEqual(["q1:yes", "q2:yes", "q3:yes"]);
	});
});

describe("createGate — response routing", () => {
	it("ignores responses for unknown ids", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);

		// Wrong id must not affect the pending request.
		expect(() => gate.handleResponse("not-an-id", "yes")).not.toThrow();
		expect(
			(
				await Promise.race([
					p,
					new Promise((r) => setTimeout(() => r("still-pending"), 30)),
				])
			).toString(),
		).toBe("still-pending");

		// Real id settles it.
		const id = extractId(broadcast);
		gate.handleResponse(id, "yes");
		expect((await p).result).toBe("yes");
	});

	it("ignores a late response after the request has settled", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		const id = extractId(broadcast);
		gate.handleResponse(id, "yes");
		expect((await p).result).toBe("yes");

		// Late response after settlement: no-op, no exception.
		expect(() => gate.handleResponse(id, "no")).not.toThrow();
		expect(() => gate.handleResponse(id, "all")).not.toThrow();
	});

	it("broadcasts approval_resolved exactly once on settlement via onResolved", async () => {
		const broadcast = vi.fn();
		const observed: string[] = [];
		const gate = createGate({
			broadcast,
			onResolved: (id) => observed.push(id),
		});

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		const id = extractId(broadcast);
		gate.handleResponse(id, "yes");
		await p;

		expect(observed).toEqual([id]);
		expect(observed).toHaveLength(1);
	});
});

describe("createGate — handleDisconnect is a no-op", () => {
	it("does not resolve a pending request when the socket disconnects", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);

		// The socket disconnecting mid-request must NOT settle it — the
		// pi-side prompt stays open awaiting the user's answer.
		gate.handleDisconnect();

		// Wait past one microtask + a tick — would be enough to surface a
		// stray resolution if handleDisconnect accidentally fired one.
		await new Promise((r) => setTimeout(r, 20));
		const settled = await Promise.race([
			p.then((o) => o.result),
			new Promise<string>((r) => setTimeout(() => r("still-pending"), 0)),
		]);
		expect(settled).toBe("still-pending");

		// The user's pi-side answer still settles it.
		const id = extractId(broadcast);
		gate.handleResponse(id, "yes");
		expect((await p).result).toBe("yes");
	});

	it("is a noop when no request is pending", () => {
		const gate = createGate({ broadcast: vi.fn() });
		expect(() => gate.handleDisconnect()).not.toThrow();
	});

	it("does not fire onResolved on disconnect", async () => {
		const broadcast = vi.fn();
		const observed: string[] = [];
		const gate = createGate({
			broadcast,
			onResolved: (id) => observed.push(id),
		});

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		gate.handleDisconnect();
		await new Promise((r) => setTimeout(r, 20));
		expect(observed).toEqual([]);

		// Cleanup so the test exits cleanly.
		const id = extractId(broadcast);
		gate.handleResponse(id, "yes");
		await p;
	});
});

describe("createGate — reset", () => {
	it("clears the per-file approval memory", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p1 = gate.requestApproval(args({ path: "/tmp/r.ts" }));
		await waitForCall(broadcast);
		const id1 = extractId(broadcast);
		gate.handleResponse(id1, "all");
		expect((await p1).result).toBe("all");

		gate.reset();

		// Memory must be cleared — this one will broadcast.
		const before = broadcast.mock.calls.length;
		const p2 = gate.requestApproval(args({ path: "/tmp/r.ts" }));
		await waitForCount(broadcast, before + 1);

		const id2 = JSON.parse(broadcast.mock.calls[before][0].trim()).id;
		gate.handleResponse(id2, "no");
		expect((await p2).result).toBe("no");
	});

	it("cancels any in-flight pending request", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		gate.reset();
		expect((await p).result).toBe("cancelled");
	});
});

describe("createGate — signal abort", () => {
	it("cancels a pending request when the agent aborts before settlement", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const ac = new AbortController();
		const p = gate.requestApproval(args({ signal: ac.signal }));
		ac.abort();
		expect((await p).result).toBe("cancelled");
	});

	it("resolves immediately as cancelled when the signal is already aborted", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const ac = new AbortController();
		ac.abort();
		const p = gate.requestApproval(args({ signal: ac.signal }));
		expect((await p).result).toBe("cancelled");
	});
});

describe("createGate — handleAck (compat)", () => {
	it("is a no-op (no ack window) — does not affect the pending request", async () => {
		const broadcast = vi.fn();
		const gate = createGate({ broadcast });

		const p = gate.requestApproval(args());
		await waitForCall(broadcast);
		const id = extractId(broadcast);
		// ack is accepted for older-nvim compat but doesn't change behavior.
		expect(() => gate.handleAck(id)).not.toThrow();

		gate.handleResponse(id, "yes");
		expect((await p).result).toBe("yes");
	});
});

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
		gate.handleResponse(id, "yes");
		expect((await p).result).toBe("yes");
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
