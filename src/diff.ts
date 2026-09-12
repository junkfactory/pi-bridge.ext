/**
 * Diff computation for the edit-approval gate.
 *
 * Given a pi `tool_call` event input for `edit` or `write`, produce a unified
 * diff of the disk file vs the post-edit content. Used to render a preview
 * in the TUI and to send to Neovim for the floating approval prompt.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import type { ApprovalTool } from "./protocol.js";

/** Maximum diff length (bytes) before we truncate. */
const DIFF_MAX_BYTES = 32 * 1024;

/** Maximum number of diff lines before we truncate. */
const DIFF_MAX_LINES = 200;

/** Marker appended when output is capped. */
const TRUNCATION_MARKER = "[… diff truncated …]";

/** Marker appended when one or more edit hunks had no exact match on disk. */
const UNMATCHED_HUNK_MARKER = (n: number) =>
	`[preview: ${n} hunk${n !== 1 ? "s" : ""} not matched]`;

export interface BuildDiffResult {
	path: string;
	diff: string;
}

/** Inputs the gate cares about from a pi tool_call event. */
export type EditInput = {
	path: string;
	edits?: Array<{ oldText: string; newText: string }>;
	oldText?: string;
	newText?: string;
};
export type WriteInput = { path: string; content: string };
export type DiffInput = EditInput | WriteInput;

/**
 * Resolve `input.path` against `cwd` when it is not absolute.
 *
 * Mirrors the convention used by pi's built-in tools: relative paths are
 * joined to cwd; absolute paths are returned unchanged.
 */
function resolvePath(path: string, cwd: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/**
 * Read the current file content from disk. Returns "" if the file does not
 * exist (matches pi's edit tool semantics for "new file"). Returns null on
 * other fs errors (EISDIR, EACCES, …) so the gate skips preview and lets the
 * tool itself surface the real error.
 */
function readDiskFile(absPath: string): string | null {
	if (!existsSync(absPath)) return "";
	try {
		return readFileSync(absPath, "utf-8");
	} catch {
		return null;
	}
}

/**
 * Apply each edit to `content` via exact split/join replacement. If an
 * `oldText` is not found in the file, skip it and count it as unmatched.
 * Returns the new content and the number of skipped hunks.
 *
 * Accepts the canonical `edits[]` array and the legacy top-level
 * `{ oldText, newText }` shape (both supported by pi's edit tool today).
 */
function applyEdits(
	content: string,
	edits: Array<{ oldText: string; newText: string }>,
): { newContent: string; unmatched: number } {
	let result = content;
	let unmatched = 0;
	for (const edit of edits) {
		const idx = result.indexOf(edit.oldText);
		if (idx === -1) {
			unmatched++;
			continue;
		}
		result =
			result.slice(0, idx) +
			edit.newText +
			result.slice(idx + edit.oldText.length);
	}
	return { newContent: result, unmatched };
}

/**
 * Normalize a `edit` input to a single `edits[]` array.
 * Handles both canonical and legacy top-level shapes.
 */
function normalizeEditInput(input: EditInput): Array<{
	oldText: string;
	newText: string;
}> {
	if (Array.isArray(input.edits) && input.edits.length > 0) return input.edits;
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		return [{ oldText: input.oldText, newText: input.newText }];
	}
	return [];
}

/**
 * Cap the diff at N lines / N bytes with a marker. Operates on a string and
 * returns the capped string. If the diff fits, it is returned unchanged.
 */
function capDiff(diff: string): string {
	const lines = diff.split("\n");
	if (lines.length <= DIFF_MAX_LINES && diff.length <= DIFF_MAX_BYTES) {
		return diff;
	}
	const truncatedLines = lines.slice(0, DIFF_MAX_LINES).join("\n");
	if (truncatedLines.length > DIFF_MAX_BYTES) {
		return `${truncatedLines.slice(0, DIFF_MAX_BYTES)}\n${TRUNCATION_MARKER}\n`;
	}
	return `${truncatedLines}\n${TRUNCATION_MARKER}\n`;
}

/**
 * Build the unified diff for a tool call.
 *
 * Returns `null` if `toolName` is not `edit`/`write`, if `input.path` is
 * missing, or if `write` input lacks `content`. For `edit`, returns `null`
 * if the input has no usable edits AND the file does not exist on disk
 * (nothing meaningful to preview).
 */
export async function buildDiff(
	toolName: ApprovalTool,
	input: DiffInput,
	cwd: string,
): Promise<BuildDiffResult | null> {
	if (typeof input?.path !== "string" || input.path.length === 0) return null;

	const absPath = resolvePath(input.path, cwd);

	if (toolName === "write") {
		const write = input as WriteInput;
		if (typeof write.content !== "string") return null;
		const oldContent = readDiskFile(absPath);
		// Unreadable target (directory, permissions) → no preview; the tool
		// fails upstream with the authoritative error.
		if (oldContent === null) return null;
		const diff = generateUnifiedPatch(absPath, oldContent, write.content);
		return { path: absPath, diff: capDiff(diff) };
	}

	// edit
	const edits = normalizeEditInput(input as EditInput);
	const oldContent = readDiskFile(absPath);
	if (oldContent === null) return null;
	const { newContent, unmatched } = applyEdits(oldContent, edits);

	// Nothing to preview: missing edits AND no existing file → skip the
	// approval widget entirely (the tool call itself will fail upstream).
	if (edits.length === 0 && oldContent === "") return null;

	let diff = generateUnifiedPatch(absPath, oldContent, newContent);
	if (unmatched > 0) {
		diff = `${diff}\n${UNMATCHED_HUNK_MARKER(unmatched)}\n`;
	}
	return { path: absPath, diff: capDiff(diff) };
}
