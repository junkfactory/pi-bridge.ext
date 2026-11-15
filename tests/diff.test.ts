import {
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDiff } from "../src/diff.js";

let tmpDir: string;

beforeAll(() => {
	tmpDir = join(tmpdir(), `pi-bridge-diff-${process.pid}-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	// Canonical base so path assertions match the realpath'd result.
	tmpDir = realpathSync(tmpDir);
});

afterAll(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
	const p = join(tmpDir, name);
	writeFileSync(p, content, "utf-8");
	return p;
}

describe("buildDiff — write", () => {
	it("returns a diff for an existing file", async () => {
		const path = writeFile("existing.txt", "hello\nworld\n");
		const result = await buildDiff(
			"write",
			{ path, content: "hello\nWORLD\n" },
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.path).toBe(path);
		expect(result?.diff).toContain("-world");
		expect(result?.diff).toContain("+WORLD");
	});

	it("returns an all-added diff for a new file", async () => {
		const path = join(tmpDir, "new-file.txt");
		const result = await buildDiff(
			"write",
			{ path, content: "fresh\ncontent\n" },
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.diff).toContain("+fresh");
		expect(result?.diff).toContain("+content");
		// No removed-content lines when the file didn't exist before (the
		// `--- a/path` header is fine; we only care about removed content).
		expect(result?.diff).not.toMatch(/^-fresh/m);
	});

	it("returns null when input.path is missing", async () => {
		const result = await buildDiff("write", { content: "x" } as never, tmpDir);
		expect(result).toBeNull();
	});

	it("returns null when content is missing", async () => {
		const result = await buildDiff(
			"write",
			{ path: "/tmp/x" } as never,
			tmpDir,
		);
		expect(result).toBeNull();
	});

	it("resolves a relative path against cwd", async () => {
		const filename = "relative.txt";
		writeFile(filename, "line a\n");
		const result = await buildDiff(
			"write",
			{ path: filename, content: "line b\n" },
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.path).toBe(join(tmpDir, filename));
	});
});

describe("buildDiff — edit", () => {
	it("applies a single edits[] entry and returns a diff", async () => {
		const path = writeFile("edit-single.ts", "const a = 1;\nconst b = 2;\n");
		const result = await buildDiff(
			"edit",
			{
				path,
				edits: [{ oldText: "const a = 1;", newText: "const a = 99;" }],
			},
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.diff).toContain("-const a = 1;");
		expect(result?.diff).toContain("+const a = 99;");
	});

	it("applies multiple edits[] entries", async () => {
		const path = writeFile("edit-multi.ts", "line one\nline two\nline three\n");
		const result = await buildDiff(
			"edit",
			{
				path,
				edits: [
					{ oldText: "line one", newText: "LINE ONE" },
					{ oldText: "line three", newText: "LINE THREE" },
				],
			},
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.diff).toContain("-line one");
		expect(result?.diff).toContain("+LINE ONE");
		expect(result?.diff).toContain("-line three");
		expect(result?.diff).toContain("+LINE THREE");
	});

	it("accepts the legacy top-level oldText/newText shape", async () => {
		const path = writeFile("edit-legacy.ts", "old value\n");
		const result = await buildDiff(
			"edit",
			{
				path,
				oldText: "old value",
				newText: "new value",
			},
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.diff).toContain("-old value");
		expect(result?.diff).toContain("+new value");
	});

	it("handles missing disk file by treating old content as empty", async () => {
		const path = join(tmpDir, "does-not-exist.ts");
		const result = await buildDiff(
			"edit",
			{
				path,
				edits: [{ oldText: "x", newText: "y" }],
			},
			tmpDir,
		);
		// oldText 'x' isn't in "" — should still produce a result with the
		// unmatched-hunk marker so the user can see why preview is empty.
		expect(result).not.toBeNull();
		expect(result?.diff).toContain("hunk");
		expect(result?.diff).toContain("not matched");
	});

	it("appends unmatched-hunk note when an oldText is not found", async () => {
		const path = writeFile("edit-mismatch.ts", "first\nsecond\n");
		const result = await buildDiff(
			"edit",
			{
				path,
				edits: [
					{ oldText: "first", newText: "FIRST" },
					{ oldText: "missing line", newText: "REPLACED" },
				],
			},
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.diff).toContain("-first");
		expect(result?.diff).toContain("+FIRST");
		expect(result?.diff).toContain("[preview: 1 hunk not matched]");
		// Plural form for >1 unmatched hunks
		const path2 = writeFile("edit-mismatch2.ts", "a\n");
		const result2 = await buildDiff(
			"edit",
			{
				path: path2,
				edits: [
					{ oldText: "no1", newText: "x" },
					{ oldText: "no2", newText: "y" },
				],
			},
			tmpDir,
		);
		expect(result2?.diff).toContain("[preview: 2 hunks not matched]");
	});

	it("returns null when path is missing", async () => {
		const result = await buildDiff(
			"edit",
			{ edits: [{ oldText: "x", newText: "y" }] } as never,
			tmpDir,
		);
		expect(result).toBeNull();
	});

	it("returns null for an edit with no edits and no existing file", async () => {
		const result = await buildDiff(
			"edit",
			{ path: join(tmpDir, "ghost.ts"), edits: [] },
			tmpDir,
		);
		expect(result).toBeNull();
	});

	it("resolves a relative path against cwd", async () => {
		const filename = "edit-relative.ts";
		writeFile(filename, "before\n");
		const result = await buildDiff(
			"edit",
			{
				path: filename,
				edits: [{ oldText: "before", newText: "after" }],
			},
			tmpDir,
		);
		expect(result?.path).toBe(join(tmpDir, filename));
	});
});

describe("buildDiff — truncation", () => {
	it("caps the diff at 200 lines and appends a marker", async () => {
		// Build a diff that is naturally large: alternating lines that all
		// change produces many hunks (each keeps a few context lines around
		// the changed pair).
		const lines: string[] = [];
		for (let i = 0; i < 1000; i++) lines.push(i % 2 === 0 ? `A${i}` : `B${i}`);
		const oldContent = lines.join("\n");
		const path = writeFile("huge.txt", oldContent);
		const newLines = lines.map((l, i) =>
			i % 2 === 0 ? `X${i}` : l.replace(/^B/, "Y"),
		);
		const newContent = newLines.join("\n");
		const result = await buildDiff(
			"write",
			{ path, content: newContent },
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.diff).toContain("[… diff truncated …]");
		const lineCount = (result?.diff ?? "").split("\n").length;
		// 200 truncated lines + the marker line + trailing newline
		expect(lineCount).toBeLessThanOrEqual(210);
	});

	it("caps the diff at 32KB", async () => {
		// Long lines force byte-cap to trigger before line-cap.
		const oldLines: string[] = [];
		const newLines: string[] = [];
		for (let i = 0; i < 300; i++) {
			const padding = "x".repeat(300);
			oldLines.push(`${padding}${i.toString().padStart(4, "0")}`);
			newLines.push(
				i % 2 === 0
					? `${padding}NEW${i}`
					: `${padding}${i.toString().padStart(4, "0")}`,
			);
		}
		const oldContent = oldLines.join("\n");
		const path = writeFile("huge-bytes.txt", oldContent);
		const newContent = newLines.join("\n");
		const result = await buildDiff(
			"write",
			{ path, content: newContent },
			tmpDir,
		);
		expect(result).not.toBeNull();
		expect(result?.diff).toContain("[… diff truncated …]");
		expect(result?.diff.length).toBeLessThanOrEqual(32 * 1024 + 100);
	});

	it("does not truncate small diffs", async () => {
		const path = writeFile("small.txt", "abc\n");
		const result = await buildDiff("write", { path, content: "xyz\n" }, tmpDir);
		expect(result?.diff).not.toContain("[… diff truncated …]");
	});
});

describe("buildDiff — fs error guards", () => {
	it("returns null when the write target is a directory (unreadable)", async () => {
		const result = await buildDiff(
			"write",
			{
				path: tmpdir(),
				content: "irrelevant",
			},
			tmpdir(),
		);
		expect(result).toBeNull();
	});
});

describe("buildDiff — canonical path identity", () => {
	it("expands a leading ~ to $HOME", async () => {
		const name = `.pi-bridge-diff-tilde-${process.pid}.lua`;
		const result = await buildDiff(
			"write",
			{ path: `~/${name}`, content: "x\n" },
			tmpDir,
		);
		expect(result?.path).toBe(join(homedir(), name));
	});

	it("strips an @ prefix", async () => {
		mkdirSync(join(tmpDir, "src"), { recursive: true });
		writeFileSync(join(tmpDir, "src", "x.lua"), "old\n", "utf-8");
		const result = await buildDiff(
			"write",
			{ path: "@src/x.lua", content: "new\n" },
			tmpDir,
		);
		expect(result?.path).toBe(join(tmpDir, "src", "x.lua"));
		expect(result?.diff).toContain("-old");
	});

	it("unifies symlinked and real paths when realpath succeeds", async () => {
		const realDir = join(tmpDir, "symlink-target");
		mkdirSync(realDir, { recursive: true });
		writeFileSync(join(realDir, "x.lua"), "old\n", "utf-8");
		const linkDir = join(tmpDir, "symlink-alias");
		symlinkSync(realDir, linkDir, "dir");

		const viaLink = await buildDiff(
			"write",
			{ path: join(linkDir, "x.lua"), content: "new\n" },
			tmpDir,
		);
		const viaReal = await buildDiff(
			"write",
			{ path: join(realDir, "x.lua"), content: "new\n" },
			tmpDir,
		);
		expect(viaLink?.path).toBe(join(realDir, "x.lua"));
		expect(viaLink?.path).toBe(viaReal?.path);
	});

	it("falls back to the resolved absolute for a nonexistent path", async () => {
		const result = await buildDiff(
			"write",
			{ path: join(tmpDir, "nope", "new.lua"), content: "fresh\n" },
			tmpDir,
		);
		expect(result?.path).toBe(join(tmpDir, "nope", "new.lua"));
		expect(result?.diff).toContain("+fresh");
	});
});

describe("buildDiff — canonical path identity (pi parity)", () => {
	// Space variants pi's `normalizePath` collapses to U+0020
	// (dist/utils/paths.js: `UNICODE_SPACES`).
	const spaceVariants: Array<[string, string]> = [
		["nbsp", "\u00A0"],
		["en", "\u2002"],
		["narrow-nbsp", "\u202F"],
		["ideo", "\u3000"],
	];

	for (const [label, space] of spaceVariants) {
		it(`collapses a ${label} space to a plain space`, async () => {
			const filename = `space ${label}.txt`;
			const canonical = writeFile(filename, "old\n");
			const variant = join(tmpDir, filename.replace(" ", space));
			const result = await buildDiff(
				"write",
				{ path: variant, content: "new\n" },
				tmpDir,
			);
			expect(result?.path).toBe(canonical);
			expect(result?.diff).toContain("-old");
		});
	}

	it("decodes a file:// URL to the filesystem path", async () => {
		const file = writeFile("url form.txt", "old\n");
		const result = await buildDiff(
			"write",
			{ path: pathToFileURL(file).href, content: "new\n" },
			tmpDir,
		);
		expect(pathToFileURL(file).href).toContain("%20");
		expect(result?.path).toBe(file);
		expect(result?.diff).toContain("-old");
	});

	it("normalizes unicode spaces before file:// decoding", async () => {
		const file = writeFile("url nbsp.txt", "old\n");
		// Literal NBSP inside the URL collapses first, then decodes.
		const raw = `file://${file.replace(" ", "\u00A0")}`;
		const result = await buildDiff(
			"write",
			{ path: raw, content: "new\n" },
			tmpDir,
		);
		expect(result?.path).toBe(file);
	});

	it("combines @-strip and tilde expansion", async () => {
		const name = `.pi-bridge-diff-at-tilde-${process.pid}.lua`;
		const result = await buildDiff(
			"write",
			{ path: `@~/${name}`, content: "x\n" },
			tmpDir,
		);
		expect(result?.path).toBe(join(homedir(), name));
	});

	it("keeps the ENOENT fallback for nonexistent unicode-space paths", async () => {
		const result = await buildDiff(
			"write",
			{ path: join(tmpDir, "ghost\u00A0dir", "x.lua"), content: "x\n" },
			tmpDir,
		);
		expect(result?.path).toBe(join(tmpDir, "ghost dir", "x.lua"));
	});
});
