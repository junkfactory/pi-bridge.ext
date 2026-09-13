/**
 * Origin flag accessor: marks the current agent turn as started by an
 * inbound Neovim `prompt` message (vs. typed directly into pi).
 *
 * Stored on globalThis so the value survives module reloads (jiti
 * re-evaluates the extension factory more than once per process), and
 * so other modules (the edit-approval gate in `src/index.ts` and the UI
 * prompt mirror in `src/prompt_mirror.ts`) can read the same value without
 * pulling `src/index.ts` into their import graph.
 *
 * Keep this file tiny: it is the shared turn-flag channel and nothing
 * else. Session-lifecycle bookkeeping still lives in `src/index.ts`.
 */

const globalScope = globalThis as typeof globalThis & {
	__piBridgeNvimTurnActive?: boolean;
};

export function getNvimTurnActive(): boolean {
	return globalScope.__piBridgeNvimTurnActive === true;
}

export function setNvimTurnActive(v: boolean): void {
	globalScope.__piBridgeNvimTurnActive = v;
}
