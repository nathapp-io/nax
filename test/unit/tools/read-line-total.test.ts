/**
 * Line totals on unranged Read calls.
 *
 * The unranged branch of readTool.run previously returned a prefix with no
 * line-count header. This file pins the new behaviour: a leading `[N lines]`
 * (or `[N+ lines]` when the prefix hit ctx.maxBytes), the prefix body
 * underneath, and the header itself part of the byte budget.
 *
 * The ranged branch is exercised separately by read-glob.test.ts and must
 * remain unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { DEFAULT_TOOL_MAX_FILE_BYTES, readTool } from "@/tools";

let root: string;

beforeEach(() => {
  root = makeTempDir("nax-line-total-");
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  cleanupTempDir(root);
});

function ctx(paths: string[], maxBytes = 10_000, maxFileBytes: number = DEFAULT_TOOL_MAX_FILE_BYTES) {
  return { root, resolvedPaths: paths, maxBytes, maxFileBytes };
}

describe("readTool — unranged line-total header", () => {
  let fiftyPath: string;

  beforeEach(() => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(root, "fifty.txt"), `${lines.join("\n")}\n`);
    fiftyPath = join(root, "fifty.txt");
  });

  test("AC1 — first content line of a 50-line unranged read is [50 lines]", async () => {
    const res = await readTool.run({ path: "fifty.txt" }, ctx([fiftyPath]));
    expect(res.isError).toBeFalsy();
    const firstLine = res.content.split("\n")[0];
    expect(firstLine).toBe("[50 lines]");
  });

  test("AC2 — header is additive: both the first and last file lines appear in the content", async () => {
    const res = await readTool.run({ path: "fifty.txt" }, ctx([fiftyPath]));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("line 1");
    expect(res.content).toContain("line 50");
  });

  test("AC3 — three-line file with no trailing newline reports [3 lines], not [4 lines]", async () => {
    const path = join(root, "three.txt");
    writeFileSync(path, "alpha\nbeta\ngamma");
    const res = await readTool.run({ path: "three.txt" }, ctx([path]));
    expect(res.isError).toBeFalsy();
    const firstLine = res.content.split("\n")[0];
    expect(firstLine).toBe("[3 lines]");
  });

  test("AC4 — empty file returns [0 lines] with no body and is not an error", async () => {
    const path = join(root, "empty.txt");
    writeFileSync(path, "");
    const res = await readTool.run({ path: "empty.txt" }, ctx([path]));
    expect(res.isError).toBeFalsy();
    expect(res.content).toBe("[0 lines]");
  });

  test("AC5 — file larger than ctx.maxBytes reports a floor: [<digits>+ lines]", async () => {
    // 30 lines * 100 bytes = 3000 bytes; maxBytes below that.
    const path = join(root, "oversize.txt");
    const line = "x".repeat(99);
    writeFileSync(path, `${line}\n`.repeat(30));
    const res = await readTool.run({ path: "oversize.txt" }, ctx([path], 500));
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/^\[\d+\+ lines\]/);
  });

  test("AC6 — oversize unranged read contains 'truncated', so the floor header and truncation marker coexist", async () => {
    const path = join(root, "oversize-trunc.txt");
    const line = "x".repeat(99);
    writeFileSync(path, `${line}\n`.repeat(30));
    const res = await readTool.run({ path: "oversize-trunc.txt" }, ctx([path], 500));
    expect(res.content).toContain("truncated");
    expect(res.content).toMatch(/^\[\d+\+ lines\]/);
  });

  test("AC7 — with maxBytes of 5 the content is no longer than 60 characters (header is inside the budget)", async () => {
    const path = join(root, "small.txt");
    writeFileSync(path, "export const a = 1;\n");
    const res = await readTool.run({ path: "small.txt" }, ctx([path], 5));
    expect(res.content.length).toBeLessThanOrEqual(60);
  });

  test("AC8 — ranged branch unchanged: offset=10 limit=5 returns [lines 10-14 of 50]", async () => {
    const res = await readTool.run({ path: "fifty.txt", offset: 10, limit: 5 }, ctx([fiftyPath]));
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("[lines 10-14 of 50]");
  });

  test("AC9 — offset past end of 50-line file returns non-error result naming line count 50", async () => {
    const res = await readTool.run({ path: "fifty.txt", offset: 999 }, ctx([fiftyPath]));
    expect(res.isError).toBeFalsy();
    expect(res.content).not.toBe("");
    expect(res.content).toContain("50");
  });

  test("AC10 — unreadable file returns isError (a tool error the model can react to), not a denial", async () => {
    const res = await readTool.run({ path: "missing.txt" }, ctx([join(root, "missing.txt")]));
    expect(res.isError).toBe(true);
  });
});

describe("readTool — unranged line total: file fits whole under maxBytes (no overrun)", () => {
  // A file that fits whole should not show a '+' suffix and should not include
  // the truncation marker.
  test("a small file returns its whole content under the [N lines] header", async () => {
    const path = join(root, "tiny.txt");
    writeFileSync(path, "alpha\nbeta\ngamma\n");
    const res = await readTool.run({ path: "tiny.txt" }, ctx([path]));
    expect(res.isError).toBeFalsy();
    expect(res.content.startsWith("[3 lines]\n")).toBe(true);
    expect(res.content).toContain("alpha");
    expect(res.content).toContain("beta");
    expect(res.content).toContain("gamma");
    expect(res.content).not.toContain("truncated");
    expect(res.content).not.toContain("+ lines");
  });
});
