/**
 * UI prompt mirror.
 *
 * Intercepts `ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.custom` for
 * any pi extension during Neovim-originated turns, mirrors each prompt
 * to Neovim, and races the two surfaces — first answer wins.
 *
 * Lifecycle:
 *   - `installMirror(ctx)` — idempotent. Wraps the ui object's
 *     `select`/`confirm`/`custom` once per session (a fresh ui object
 *     is built per session bind in pi; the marker symbol survives only
 *     for that object).
 *   - Wrappers gate on `active()` = env kill switch off AND
 *     `mirrorReady` AND nvim-originated turn. Inactive → original
 *     called untouched.
 *   - `setMirrorReady(true|false)` — flipped by inbound `mirror_ready`
 *     and on socket disconnect (Step 4 wiring).
 *   - `getMirror()?.reset()` — at session boundaries; settles any
 *     in-flight structured prompt as cancelled and drops custom
 *     component refs. The ready flag persists for the session.
 *
 * Singleton state lives on `globalThis` so jiti module reloads adopt
 * the live controller instead of leaving orphan instances hanging on
 * the socket state — same pattern as `src/approval.ts` and
 * `src/handler.ts`.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { serializeEvent } from "./protocol.js";
import { broadcast } from "./socket.js";
import { getNvimTurnActive } from "./turn.js";
import { isEscapeKey, type PromptOptionsHandle, promptOptions } from "./ui.js";

// ---------------------------------------------------------------------------
// Shared singleton state (survives jiti module reloads within one process)
// ---------------------------------------------------------------------------

const globalScope = globalThis as typeof globalThis & {
	__piBridgeMirror?: Mirror | null;
	__piBridgeMirrorReady?: boolean;
};

/**
 * Non-enumerable marker placed on the wrapped ui object so a second
 * `installMirror` call on the same ui instance is a no-op. Fresh ui
 * objects are built per session bind in pi, so this only guards
 * against the same object being wrapped twice in one session.
 */
const INSTALLED = Symbol.for("pi-bridge.mirror.installed");

/** Reflects inbound `mirror_ready`; cleared on socket disconnect. */
export function isMirrorReady(): boolean {
	return globalScope.__piBridgeMirrorReady === true;
}

export function setMirrorReady(v: boolean): void {
	globalScope.__piBridgeMirrorReady = v;
}

/** Get the live mirror controller, or null if `installMirror` hasn't run. */
export function getMirror(): Mirror | null {
	return globalScope.__piBridgeMirror ?? null;
}

/**
 * Adopt the given mirror as the live singleton (used by tests to swap
 * in a stub; production code lazily creates one in `installMirror`).
 */
export function setMirror(mirror: Mirror | null): void {
	globalScope.__piBridgeMirror = mirror;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal structural shape of a pi-tui Component, matching `src/ui.ts`. */
interface ComponentLike {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	dispose?(): void;
}

/** A pending mirror entry for a structured prompt (select/confirm). */
interface StructuredPending {
	kind: "select" | "confirm";
	id: string;
	/**
	 * Settle the structured prompt with the given value (a label, or
	 * `undefined` for cancelled). First-wins; subsequent calls are
	 * no-ops. Broadcasts `ui_prompt_resolved` exactly once for this id
	 * across all paths (nvim answer, pi answer, remote dismissal,
	 * `reset()`).
	 */
	settle(value: string | undefined): void;
}

/** A pending mirror entry for a custom component mirror. */
interface CustomPending {
	kind: "custom";
	id: string;
	component: ComponentLike | null;
	/**
	 * Broadcast `ui_prompt_resolved` once for this id. Called when the
	 * wrapped component's `done()` fires, when the wrapper is reset, or
	 * when a late answer arrives after the component was dropped.
	 */
	resolve(): void;
	/** Whether `resolve()` has fired (first-wins / no-double-broadcast). */
	resolved: boolean;
}

type PendingEntry = StructuredPending | CustomPending;

/** Inbound payload after protocol validation; one of the three forms. */
export type ResponsePayload =
	| { kind: "value"; value: string }
	| { kind: "cancelled" }
	| { kind: "key"; key: string };

export interface CreateMirrorOptions {
	/** Write a serialized event to all connected clients. */
	broadcast: (data: string) => void;
	/**
	 * Hook fired when the mirror settles a pending entry (any path:
	 * nvim answer, pi answer, remote dismissal, or `reset()`). Lets
	 * the caller log or extend. Errors thrown here must not break the
	 * mirror.
	 */
	onResolved?: (id: string) => void;
}

/**
 * Mirror controller. One instance per process; shared across all
 * session-scoped wrappers via the globalThis singleton in this module.
 */
export interface Mirror {
	/**
	 * Whether the mirror's wrappers should intercept this turn. False
	 * when any of: env kill switch, nvim hasn't sent `mirror_ready`,
	 * or the current turn was not nvim-originated.
	 */
	isActive(): boolean;
	/**
	 * Wrap a structured-prompt call. `options` is the label list the
	 * caller would have passed to `ui.select`/`ui.confirm`; the
	 * mirror races nvim's answer against the pi-side dismissable
	 * surface and returns the winning label (or `undefined` for
	 * cancelled) — matching pi's own RPC semantics. The original
	 * implementation is invoked untouched when `isActive()` is false.
	 */
	runSelect(
		ctx: ExtensionContext,
		title: string,
		options: readonly string[],
		original: (
			title: string,
			options: readonly string[],
			opts?: { signal?: AbortSignal },
		) => Promise<string | undefined>,
		opts?: { signal?: AbortSignal },
	): Promise<string | undefined>;
	/**
	 * Wrap a confirm call. Options collapse to `["Yes", "No"]`;
	 * cancellation returns `false` (matches pi's own RPC semantics,
	 * rpc-mode.js:85). Behaviour otherwise identical to `runSelect`.
	 * `message` is pi's confirm dialog message; it is forwarded to the
	 * original when active is false (the mirror shows its own picker
	 * driven by `title`).
	 */
	runConfirm(
		ctx: ExtensionContext,
		title: string,
		message: string,
		original: (
			title: string,
			message: string,
			opts?: { signal?: AbortSignal },
		) => Promise<boolean>,
		opts?: { signal?: AbortSignal },
	): Promise<boolean>;
	/**
	 * Wrap a custom-component call. Pass-through (no broadcast, no
	 * wrapping) when the user factory's component lacks `render` or
	 * `handleInput`. Otherwise captures the component, wraps `render`
	 * (broadcast on line change only) and `done` (broadcast resolved
	 * once, unregister), and returns the wrapped component for pi to
	 * mount. The original `ui.custom` is invoked with the wrapped
	 * factory and its returned promise is passed through untouched.
	 */
	runCustom<T>(
		ctx: ExtensionContext,
		userFactory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => ComponentLike | Promise<ComponentLike>,
		original: (
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => ComponentLike | Promise<ComponentLike>,
			options?: { overlay?: boolean },
		) => Promise<T>,
		options?: { overlay?: boolean },
	): Promise<T>;
	/** Route a parsed `ui_prompt_response` to its pending entry. */
	handleResponse(id: string, payload: ResponsePayload): void;
	/**
	 * Settle any in-flight structured prompts as cancelled and drop
	 * custom component refs. Ready flag is NOT touched (it persists
	 * across session boundaries per the design).
	 */
	reset(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMirror(opts: CreateMirrorOptions): Mirror {
	const { broadcast: emit, onResolved } = opts;

	const pending = new Map<string, PendingEntry>();

	const fireResolved = (id: string) => {
		try {
			onResolved?.(id);
		} catch {
			// Listener errors must not break the mirror.
		}
	};

	const broadcastResolved = (id: string) => {
		try {
			emit(serializeEvent({ type: "ui_prompt_resolved", id }));
		} catch {
			// Broadcast failures must not strand the race; the caller
			// already settled via the gate's first-wins guard.
		}
	};

	const isActive = (): boolean => {
		if (process.env.PI_BRIDGE_UI_PROMPT_MIRROR === "0") return false;
		if (!isMirrorReady()) return false;
		if (!getNvimTurnActive()) return false;
		return true;
	};

	/**
	 * Race nvim's answer against the pi-side surface for a structured
	 * prompt. Returns the winning label (or `undefined` for cancelled).
	 * `ui_prompt_resolved` is broadcast exactly once on settlement,
	 * whichever side wins. If the AbortSignal is already fired, the
	 * mirror short-circuits to a cancelled settlement without opening
	 * any surface.
	 */
	const runStructured = async (
		ctx: ExtensionContext,
		kind: "select" | "confirm",
		title: string,
		options: readonly string[],
		opts: { signal?: AbortSignal } | undefined,
	): Promise<string | undefined> => {
		// Aborted before we started — don't mirror. Settle as cancelled
		// so the caller sees a coherent outcome without UI flicker.
		if (opts?.signal?.aborted) {
			return undefined;
		}

		const id = randomUUID();

		// Resolve nvimAnswer when nvim settles (either via the typed
		// value or cancelled); the structured race awaits this.
		let resolveNvimAnswer!: (value: string | undefined) => void;
		const nvimAnswer = new Promise<string | undefined>((resolve) => {
			resolveNvimAnswer = resolve;
		});

		// Pi-side dismissable surface. We hold the handle so we can
		// dismiss() it on nvim-wins or on reset().
		const piHandle: PromptOptionsHandle = promptOptions(ctx, title, options);

		// First-wins gate around both sides' settlements.
		let settled = false;
		const settleOnce = (value: string | undefined, source: "nvim" | "pi") => {
			if (settled) return;
			settled = true;
			// Unregister before broadcasting resolved so a late answer
			// for this id no-ops cleanly.
			pending.delete(id);
			// Dismiss whichever side didn't win.
			if (source === "nvim") piHandle.dismiss();
			resolveNvimAnswer(value);
			broadcastResolved(id);
			fireResolved(id);
		};

		const entry: StructuredPending = {
			kind,
			id,
			settle(value) {
				settleOnce(value, "nvim");
			},
		};
		pending.set(id, entry);

		// Broadcast the request before wiring the pi-side listener so
		// nvim can race in. Throwing here would strand the promise — wrap
		// in a defensive try and treat as cancelled.
		try {
			emit(
				serializeEvent({
					type: "ui_prompt_request",
					id,
					kind,
					title,
					options: [...options],
				}),
			);
		} catch (_err) {
			// Broadcast failed — settle as cancelled so the caller isn't
			// stuck. The pi-side surface still works; the race resolves
			// through the pi branch.
			settleOnce(undefined, "pi");
			// Fall through to the await; the pi path will short-circuit
			// the race because nvimAnswer was already resolved.
			return await nvimAnswer;
		}

		// Pi-side: when the user answers in the pi terminal, settle via
		// the pi branch (no broadcast needed on nvim side — we'll
		// broadcast resolved as part of settleOnce).
		void piHandle.decision.then((decision) => {
			if (decision === "cancelled") settleOnce(undefined, "pi");
			else settleOnce(decision.label, "pi");
		});

		// If the abort signal fires mid-flight, settle as cancelled.
		const signal = opts?.signal;
		if (signal) {
			if (signal.aborted) {
				settleOnce(undefined, "pi");
			} else {
				signal.addEventListener("abort", () => settleOnce(undefined, "pi"), {
					once: true,
				});
			}
		}

		return await nvimAnswer;
	};

	const runSelect = (
		ctx: ExtensionContext,
		title: string,
		options: readonly string[],
		original: (
			title: string,
			options: readonly string[],
			opts?: { signal?: AbortSignal },
		) => Promise<string | undefined>,
		opts?: { signal?: AbortSignal },
	) => {
		if (!isActive() || opts?.signal?.aborted) {
			return original(title, options, opts);
		}
		return runStructured(ctx, "select", title, options, opts);
	};

	const runConfirm = (
		ctx: ExtensionContext,
		title: string,
		_message: string,
		original: (
			title: string,
			message: string,
			opts?: { signal?: AbortSignal },
		) => Promise<boolean>,
		opts?: { signal?: AbortSignal },
	) => {
		if (!isActive() || opts?.signal?.aborted) {
			return original(title, _message, opts);
		}
		// Confirm collapses to a 2-option select; the mapping to a
		// boolean happens in the wrapper returned to the caller.
		const confirmOptions = ["Yes", "No"] as const;
		return runStructured(ctx, "confirm", title, confirmOptions, opts).then(
			(value) => {
				// Per the plan: cancelled → `false` (matches pi's RPC
				// semantics). A real "Yes" → `true`; "No" or any other
				// answer → `false`.
				return value === "Yes";
			},
		);
	};

	const runCustom = async <T>(
		_ctx: ExtensionContext,
		userFactory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (result: T) => void,
		) => ComponentLike | Promise<ComponentLike>,
		original: (
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: T) => void,
			) => ComponentLike | Promise<ComponentLike>,
			options?: { overlay?: boolean },
		) => Promise<T>,
		options?: { overlay?: boolean },
	): Promise<T> => {
		// Per the design: feature-detection happens BEFORE we commit to
		// broadcasting — components without render/handleInput pass
		// through untouched. We don't have the component yet (the
		// factory is what produces it), so the factory wrapper does the
		// detection.
		const id = randomUUID();

		// Per the design: "wrap done → broadcast ui_prompt_resolved
		// once, unregister". The user's factory captures the `done`
		// parameter and may invoke it on hotkey; we must wrap BEFORE
		// invoking the user factory so it sees the wrapped version.
		let doneWrapper: ((result: T) => void) | undefined;

		const wrappedFactory = async (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			rawDone: (result: T) => void,
		): Promise<ComponentLike> => {
			// Track whether we ever committed to mirroring (component
			// was mirror-able). Until then, wrappedDone is a no-op so a
			// factory that calls done synchronously before the
			// component is created (or that returns a non-mirror-able
			// component) doesn't broadcast a stale resolved event.
			let mirrorCommitted = false;
			let doneResolved = false;
			const wrappedDone = (result: T) => {
				if (doneResolved) return;
				doneResolved = true;
				if (mirrorCommitted) {
					broadcastResolved(id);
					const entry = pending.get(id);
					if (entry && entry.kind === "custom") {
						entry.resolved = true;
						pending.delete(id);
						fireResolved(id);
					}
				}
				rawDone(result);
			};
			doneWrapper = wrappedDone;

			let component: ComponentLike;
			try {
				component = (await userFactory(
					tui,
					theme,
					keybindings,
					wrappedDone,
				)) as ComponentLike;
			} catch {
				// Factory threw — re-raise so pi's own overlay pipeline
				// surfaces the error. The wrapped done was never invoked.
				throw new Error("user factory threw");
			}

			// Feature-detect: missing component OR missing render OR
			// missing handleInput → pass through (no broadcast, no
			// wrap). The user factory owns completion for the
			// pass-through; doneWrapper is a no-op because
			// mirrorCommitted stays false.
			if (
				!component ||
				typeof component.render !== "function" ||
				typeof component.handleInput !== "function"
			) {
				return component;
			}

			mirrorCommitted = true;

			// Capture & wrap. `component` is the live object returned by
			// the user's factory; we mutate it in place (shallow wrap).
			const componentRef = component;
			let lastLines = "";
			let firstRender = true;
			// Disabled after a broadcast failure: we can't tell nvim
			// anyway, and further renders should not waste work.
			let disabled = false;
			const safeEmit = (data: string) => {
				try {
					emit(data);
				} catch {
					disabled = true;
				}
			};
			const origRender = component.render.bind(component);
			component.render = (width: number): string[] => {
				const lines = origRender(width);
				if (disabled) return lines;
				const payload = serializeEvent({
					type: "ui_prompt_request",
					id,
					kind: "custom",
					lines,
				});
				if (firstRender) {
					firstRender = false;
					lastLines = lines.join("\n");
					safeEmit(payload);
				} else {
					const joined = lines.join("\n");
					if (joined !== lastLines) {
						lastLines = joined;
						safeEmit(payload);
					}
				}
				return lines;
			};

			// Register the pending custom entry. Resolution happens
			// through wrappedDone (above) when the user invokes the
			// component's done callback.
			pending.set(id, {
				kind: "custom",
				id,
				component: componentRef,
				resolve: () => {
					// Direct path used by reset() / late nvim key injection
					// that bypasses the component's done. wrappedDone is
					// called instead so pi's overlay pipeline closes the
					// dialog the same way a hotkey would.
					if (doneWrapper) doneWrapper(undefined as unknown as T);
				},
				resolved: false,
			});

			return component;
		};

		// Delegate to pi's original ui.custom; its returned promise is
		// passed through untouched. The wrapper preserves the overlay
		// option so pi's own dialog/overlay behavior is unchanged.
		return await original(wrappedFactory, options);
	};

	const handleResponse = (id: string, payload: ResponsePayload): void => {
		const entry = pending.get(id);
		if (!entry) return; // unknown id or already settled; no-op

		if (payload.kind === "key") {
			if (entry.kind !== "custom") {
				// key on a structured entry — protocol error. Drop it
				// rather than crash; the structured entry's settle path
				// is the only valid settlement.
				return;
			}
			const component = entry.component;
			if (!component || typeof component.handleInput !== "function") return;
			// Escape byte-form parity: the gate already ships a working
			// isEscapeKey matcher; components expect the raw `\x1b` form
			// regardless of the terminal's keyboard protocol. Normalize
			// any escape form to the canonical byte so handlers that
			// check `data === "\x1b"` (or use isEscapeKey themselves)
			// both match.
			const injected = isEscapeKey(payload.key) ? "\x1b" : payload.key;
			component.handleInput(injected);
			return;
		}

		if (entry.kind !== "select" && entry.kind !== "confirm") {
			// value/cancelled on a custom entry — protocol error. Drop.
			return;
		}
		if (payload.kind === "cancelled") {
			entry.settle(undefined);
		} else {
			entry.settle(payload.value);
		}
	};

	const reset = () => {
		// Settle any in-flight structured prompts as cancelled so
		// callers waiting on the race don't hang across session
		// boundaries. Custom dialogs are torn down by pi's own close
		// paths; we only drop our refs and broadcast resolved so nvim's
		// float closes.
		for (const [id, entry] of pending) {
			if (entry.kind === "select" || entry.kind === "confirm") {
				entry.settle(undefined);
			} else {
				// Custom: broadcast resolved once, drop the ref. We do
				// NOT call wrappedDone here — the user component's own
				// done callback is the only legitimate settlement; a
				// session switch leaving it open is a pi-side concern.
				const custom = entry as CustomPending;
				if (!custom.resolved) {
					custom.resolved = true;
					broadcastResolved(id);
					fireResolved(id);
				}
			}
		}
		pending.clear();
	};

	return {
		isActive,
		runSelect,
		runConfirm,
		runCustom,
		handleResponse,
		reset,
	};
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Wrap `ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.custom` with the
 * mirror. Idempotent: a non-enumerable marker symbol on the ui object
 * prevents double-wrap on the same instance. Each session bind in pi
 * produces a fresh ui object, so re-calling on the next session is
 * required — and safe.
 *
 * `installMirror` does NOT install anything when the env kill switch is
 * set: callers (Step 4 wiring) may also gate at the call site, but
 * returning early here keeps the marker off the ui object so a later
 * enable isn't blocked by a stale marker.
 */
export function installMirror(ctx: ExtensionContext): Mirror | null {
	if (process.env.PI_BRIDGE_UI_PROMPT_MIRROR === "0") return null;

	const ui = ctx.ui as unknown as Record<symbol | string, unknown>;
	if (ui[INSTALLED] === true) return getMirror();

	const mirror =
		getMirror() ??
		(() => {
			const m = createMirror({ broadcast: (data) => broadcast(data) });
			setMirror(m);
			return m;
		})();

	const originalSelect = ctx.ui.select.bind(ctx.ui) as unknown as (
		title: string,
		options: readonly string[],
		opts?: { signal?: AbortSignal },
	) => Promise<string | undefined>;
	const originalConfirm = ctx.ui.confirm.bind(ctx.ui) as unknown as (
		title: string,
		message: string,
		opts?: { signal?: AbortSignal },
	) => Promise<boolean>;
	const originalCustom = ctx.ui.custom.bind(ctx.ui) as unknown as (
		factory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (result: unknown) => void,
		) => unknown,
		options?: { overlay?: boolean },
	) => Promise<unknown>;

	ctx.ui.select = ((
		title: string,
		options: string[],
		opts?: { signal?: AbortSignal },
	) =>
		mirror.runSelect(
			ctx,
			title,
			options,
			originalSelect,
			opts,
		)) as typeof ctx.ui.select;

	ctx.ui.confirm = ((
		title: string,
		message: string,
		opts?: { signal?: AbortSignal },
	) =>
		mirror.runConfirm(
			ctx,
			title,
			message,
			originalConfirm,
			opts,
		)) as typeof ctx.ui.confirm;

	ctx.ui.custom = ((
		factory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (result: unknown) => void,
		) => unknown,
		options?: { overlay?: boolean },
	) =>
		mirror.runCustom(
			ctx,
			factory as Parameters<typeof mirror.runCustom>[1],
			originalCustom as unknown as Parameters<typeof mirror.runCustom>[2],
			options,
		)) as unknown as typeof ctx.ui.custom;

	try {
		Object.defineProperty(ctx.ui, INSTALLED, {
			value: true,
			enumerable: false,
			configurable: true,
			writable: false,
		});
	} catch {
		// Object is frozen or sealed — fall through without a marker.
		// installMirror still installed the wrappers; the next call
		// will re-wrap (harmless duplicate work, but correctness is
		// preserved because the wrappers themselves are idempotent at
		// call time — they gate on active() and only act once per id).
	}

	return mirror;
}
