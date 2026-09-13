/**
 * Approval gate state machine.
 *
 * Coordinates the lifecycle of an in-flight approval request:
 *   - Per-file approval memory (path → remembered "a" decisions).
 *   - Queue serialization so two concurrent tool calls don't fight over
 *     one prompt (parallel tool execution is the common case).
 *   - First resolution wins (response); late events for unknown/settled
 *     ids are ignored.
 *
 * The gate itself does not touch any pi UI; `requestApproval` returns one
 * of the strings below and the caller drives the prompt:
 *
 *   - "yes"      — Neovim (or the pi prompt) approved this single tool call.
 *   - "all"      — Neovim (or the pi prompt) approved this and all future
 *                  edits to `path`.
 *   - "no"       — rejected; block the tool call.
 *   - "cancelled" — the user pressed Esc in the pi prompt; block the tool call.
 *
 * There is no longer a "fallback" decision or an ack-timer window. If
 * Neovim disconnects mid-request, the pending request is left alone —
 * the pi-side prompt stays open awaiting the user's answer (per the
 * agreed design). The pi prompt is the canonical decision surface once
 * the request is in flight; nvim's response and the pi keypress race
 * against each other under first-wins.
 */

import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalTool } from "./protocol.js";

export interface RequestApprovalArgs {
	tool: ApprovalTool;
	path: string;
	diff: string;
	signal: AbortSignal | undefined;
	/**
	 * Optional pre-generated request id. When provided, the gate uses it
	 * instead of generating its own UUID. Callers that need synchronous
	 * access to the id (to feed pi-prompt decisions back into the gate
	 * while the request is still pending) should generate the id here.
	 */
	id?: string;
}

export type ApprovalResult = ApprovalDecision | "cancelled";

/**
 * A pending approval request. One of these exists at a time; subsequent
 * requests are queued behind it.
 */
interface Pending {
	id: string;
	path: string;
	resolve: (r: ApprovalResult) => void;
}

export interface CreateGateOptions {
	/** Write a serialized event to all connected clients. */
	broadcast: (data: string) => void;
	/**
	 * Called when the request has been settled (response, or session
	 * reset). The id is provided so the caller can include it in the
	 * `approval_resolved` broadcast.
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
	 * request id (which the caller needs to broadcast `approval_resolved`).
	 */
	requestApproval(args: RequestApprovalArgs): Promise<ApprovalRequestOutcome>;
	handleAck(id: string): void;
	handleResponse(id: string, decision: ApprovalDecision): void;
	/**
	 * Resolve a pending request as cancelled (e.g. the user pressed Esc
	 * in the pi-side prompt). Distinct from `handleResponse` because the
	 * wire protocol doesn't carry "cancelled" — it carries yes/all/no only.
	 */
	handleCancel(id: string): void;
	handleDisconnect(): void;
	reset(): void;
}

/**
 * Factory: build a new gate. Each session should create its own gate and
 * stash it on a shared singleton (e.g. `globalThis`) so module reloads
 * adopt the live one — same pattern as the socket state in `src/socket.ts`.
 */
export function createGate(opts: CreateGateOptions): Gate {
	const { broadcast, onResolved } = opts;

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

			const id = args.id ?? randomUUID();
			let onAbort: (() => void) | undefined;

			let resolved = false;
			const pendingEntry: Pending = {
				id,
				path: args.path,
				resolve: (r) => {
					if (resolved) return;
					resolved = true;
					if (onAbort && args.signal) {
						args.signal.removeEventListener("abort", onAbort);
					}
					if (pending === pendingEntry) pending = null;
					fireResolved(id);
					resolveOuter({ id, result: r });
				},
			};
			pending = pendingEntry;

			// Broadcast the request immediately. The Neovim side answers
			// with `approval_response` (decision). There's no ack window —
			// either side's answer is first-wins.
			broadcast(
				`${JSON.stringify({
					type: "approval_request",
					id,
					tool: args.tool,
					path: args.path,
					diff: args.diff,
				})}\n`,
			);

			// Watch the abort signal: if the agent turn is aborted while the
			// prompt is up (e.g. Ctrl+C), cancel the pending request so the
			// tool call resolves instead of hanging.
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

	const handleAck = (_id: string) => {
		// No-op kept for compatibility: nvim still sends approval_ack for
		// older-pi compat. The gate no longer needs it — there's no ack
		// window — but we accept the message so the protocol stays
		// forward-compatible.
	};

	const handleResponse = (id: string, decision: ApprovalDecision) => {
		if (pending?.id !== id) return; // late or unknown id; first wins
		// If Neovim answered "all", remember the path so future edits to
		// the same file are auto-approved.
		if (decision === "all") approvedFiles.add(pending.path);
		pending.resolve(decision);
	};

	const handleCancel = (id: string) => {
		if (pending?.id !== id) return; // late or unknown id; first wins
		pending.resolve("cancelled");
	};

	const handleDisconnect = () => {
		// Per the agreed design: a nvim disconnect mid-request must NOT
		// resolve the pending request. The pi-side prompt stays open and
		// the user's answer (or Esc / Ctrl+C) is the only path forward.
		// Log only.
	};

	const reset = () => {
		approvedFiles.clear();
		generation++;
		// Resolve any pending request as cancelled so callers waiting on the
		// promise chain don't hang across session boundaries.
		if (pending) pending.resolve("cancelled");
		pending = null;
		// A fresh chain so a stale rejection from a previous session can't
		// influence future requests.
		queueTail = Promise.resolve();
	};

	return {
		requestApproval,
		handleAck,
		handleResponse,
		handleCancel,
		handleDisconnect,
		reset,
	};
}
