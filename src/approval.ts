/**
 * Approval gate state machine.
 *
 * Coordinates the lifecycle of an in-flight approval request:
 *   - Per-file approval memory (path → remembered "a" decisions).
 *   - Queue serialization so two concurrent tool calls don't fight over
 *     one prompt (parallel tool execution is the common case).
 *   - Ack window: if Neovim hasn't acked within `ackTimeoutMs`, the caller
 *     is told to fall back to the pi TUI overlay.
 *   - First resolution wins (ack-then-response, or fallback); late events
 *     for unknown/settled ids are ignored.
 *
 * The gate itself does not touch any pi UI; `requestApproval` returns one
 * of the strings below and the caller drives the widget/overlay:
 *
 *   - "yes"      — Neovim approved this single tool call.
 *   - "all"      — Neovim approved this and all future edits to `path`.
 *   - "no"       — Neovim rejected; block the tool call.
 *   - "cancelled" — the agent turn was aborted (signal); block the tool call.
 *   - "fallback" — no ack in time, or the socket disconnected; the caller
 *                  should run the pi TUI overlay and feed its decision back
 *                  through `settle()`.
 */

import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalTool } from "./protocol.js";

export interface RequestApprovalArgs {
	tool: ApprovalTool;
	path: string;
	diff: string;
	signal: AbortSignal | undefined;
}

export type ApprovalResult = ApprovalDecision | "cancelled" | "fallback";

/**
 * A pending approval request. One of these exists at a time; subsequent
 * requests are queued behind it.
 */
interface Pending {
	id: string;
	path: string;
	resolve: (r: ApprovalResult) => void;
	/** Set when an ack has been received; resolution moves to response-only. */
	acked: boolean;
}

export interface CreateGateOptions {
	/** Write a serialized event to all connected clients. */
	broadcast: (data: string) => void;
	/** Window to wait for an `approval_ack` before falling back. */
	ackTimeoutMs?: number;
	/**
	 * Called when the request has been settled (response, fallback, or
	 * disconnect) and the caller may want to broadcast an `approval_resolved`.
	 * The id is provided so the caller can include it in the resolved event.
	 */
	onResolved?: (id: string) => void;
}

export interface ApprovalRequestOutcome {
	id: string;
	result: ApprovalResult;
}

export interface Gate {
	/**
	 * Enqueue an approval request. Resolves to the result plus the
	 * request id (which the caller needs to broadcast approval_resolved
	 * and to feed back the fallback overlay's decision through settle()).
	 */
	requestApproval(args: RequestApprovalArgs): Promise<ApprovalRequestOutcome>;
	handleAck(id: string): void;
	handleResponse(id: string, decision: ApprovalDecision): void;
	/**
	 * Settle a fallback-path request that the caller has finalized itself
	 * (e.g. via the pi TUI overlay). Updates the per-file "all" memory
	 * regardless of whether the live pending entry still exists — the id
	 * is paired with the path so the call has effect after the pending
	 * entry is already cleared by the fallback path.
	 */
	settle(id: string, decision: ApprovalDecision, path: string): void;
	handleDisconnect(): void;
	reset(): void;
}

/**
 * Factory: build a new gate. Each session should create its own gate and
 * stash it on a shared singleton (e.g. `globalThis`) so module reloads
 * adopt the live one — same pattern as the socket state in `src/socket.ts`.
 */
export function createGate(opts: CreateGateOptions): Gate {
	const { broadcast, ackTimeoutMs = 1000, onResolved } = opts;

	/** Per-file "a" memory. Cleared by `reset()`. */
	const approvedFiles = new Set<string>();

	/** Currently pending request, if any. Queue is the tail of the chain. */
	let pending: Pending | null = null;
	let queueTail: Promise<void> = Promise.resolve();
	/**
	 * Bumped by `reset()`. Queued `runOne` invocations from a previous
	 * generation short-circuit without broadcasting, so a session switch
	 * can't surface a stale prompt in the new session.
	 */
	let generation = 0;
	/**
	 * Map from request id → path, retained after the pending entry clears
	 * so `settle()` can still find the path for late ack→response→settle
	 * sequences. Cleared by `reset()`.
	 */
	const idToPath = new Map<string, string>();

	const fireResolved = (id: string) => {
		try {
			onResolved?.(id);
		} catch {
			// Listener errors must not break the gate.
		}
	};

	/**
	 * Public API: enqueue an approval request. Returns the result plus the
	 * id so the caller can match the response from Neovim / overlay back
	 * to its own broadcast of `approval_resolved`.
	 */
	const requestApproval = (
		args: RequestApprovalArgs,
	): Promise<ApprovalRequestOutcome> => {
		// Per-file "all" memory short-circuits before queueing — no id, no
		// broadcast (the original request was already approved forever).
		if (approvedFiles.has(args.path)) {
			return Promise.resolve({ id: "", result: "all" });
		}

		// Serialize: each request awaits the previous one settling.
		// `gen` is captured at enqueue time — a queued request that starts
		// running only after a session reset must short-circuit.
		const gen = generation;
		const next = queueTail.then(() => runOne(args, gen));
		// Swallow rejections on the tail so a rejected request doesn't
		// poison subsequent ones. `runOne` never rejects — but defensive.
		queueTail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	function runOne(
		args: RequestApprovalArgs,
		gen: number,
	): Promise<ApprovalRequestOutcome> {
		return new Promise<ApprovalRequestOutcome>((resolveOuter) => {
			// Short-circuit requests queued before a session reset: they must
			// not broadcast into the new session.
			if (gen !== generation) {
				resolveOuter({ id: "", result: "cancelled" });
				return;
			}

			// Defensive: even if a path was approved between queueing and
			// starting, short-circuit here.
			if (approvedFiles.has(args.path)) {
				resolveOuter({ id: "", result: "all" });
				return;
			}

			const id = randomUUID();
			// Declare timer/abort handler up front so the pending resolver
			// closure can reference them without a TDZ trap.
			let ackTimer: ReturnType<typeof setTimeout> | undefined;
			let onAbort: (() => void) | undefined;

			let resolved = false;
			idToPath.set(id, args.path);
			const pendingEntry: Pending = {
				id,
				path: args.path,
				resolve: (r) => {
					if (resolved) return;
					resolved = true;
					if (ackTimer) clearTimeout(ackTimer);
					if (onAbort && args.signal) {
						args.signal.removeEventListener("abort", onAbort);
					}
					if (pending === pendingEntry) pending = null;
					// The path is captured by the caller's closure (`settle`
					// receives it explicitly), so the id→path entry can be
					// dropped now to keep the map bounded within a session.
					idToPath.delete(id);
					fireResolved(id);
					resolveOuter({ id, result: r });
				},
				acked: false,
			};
			pending = pendingEntry;

			// Broadcast the request immediately. The Neovim side answers
			// with `approval_ack` (liveness) and `approval_response`
			// (decision).
			broadcast(
				`${JSON.stringify({
					type: "approval_request",
					id,
					tool: args.tool,
					path: args.path,
					diff: args.diff,
				})}\n`,
			);

			// Ack window: if no ack arrives in time, we go to the fallback
			// path. After ack, the wait is open-ended (bounded only by the
			// agent's own abort signal).
			ackTimer = setTimeout(() => {
				if (!pendingEntry.acked && pending === pendingEntry) {
					pendingEntry.resolve("fallback");
				}
			}, ackTimeoutMs);

			// Watch the abort signal: if the user hits Esc during a
			// tool_call wait, the agent aborts and we resolve as cancelled.
			onAbort = () => pendingEntry.resolve("cancelled");
			if (args.signal && !args.signal.aborted) {
				args.signal.addEventListener("abort", onAbort, { once: true });
			} else if (args.signal?.aborted) {
				// Already aborted before we started.
				pendingEntry.resolve("cancelled");
				return;
			}
		});
	}

	const handleAck = (id: string) => {
		if (pending?.id === id) pending.acked = true;
	};

	const handleResponse = (id: string, decision: ApprovalDecision) => {
		if (pending?.id !== id) return; // late or unknown id; first wins
		// If Neovim answered "all", remember the path so future edits to
		// the same file are auto-approved.
		if (decision === "all") approvedFiles.add(pending.path);
		pending.resolve(decision);
	};

	const settle = (id: string, decision: ApprovalDecision, path: string) => {
		// `settle` is the public name for "the caller has finalized the
		// decision through the pi TUI overlay". The gate has already
		// released its pending entry; we just update per-file memory for
		// "all" decisions.
		if (decision === "all") {
			const knownPath = idToPath.get(id) ?? path;
			approvedFiles.add(knownPath);
		}
	};

	const handleDisconnect = () => {
		if (!pending) return;
		// A request was in flight (acked or not). Release the caller to the
		// fallback path; a reconnect may decide differently on a new request.
		pending.resolve("fallback");
	};

	const reset = () => {
		approvedFiles.clear();
		generation++;
		// Resolve any pending request as cancelled so callers waiting on the
		// promise chain don't hang across session boundaries.
		if (pending) pending.resolve("cancelled");
		pending = null;
		idToPath.clear();
		// A fresh chain so a stale rejection from a previous session can't
		// influence future requests.
		queueTail = Promise.resolve();
	};

	return {
		requestApproval,
		handleAck,
		handleResponse,
		settle,
		handleDisconnect,
		reset,
	};
}
