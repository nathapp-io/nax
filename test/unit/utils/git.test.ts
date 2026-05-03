/**
 * Unit tests for git utility functions (TC-003)
 *
 * Covers: detectMergeConflict helper, captureOutputFiles helper (ENH-005)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _gitDeps, captureOutputFiles, detectMergeConflict } from "../../../src/utils/git";

describe("detectMergeConflict", () => {
  test("returns true when output contains uppercase CONFLICT", () => {
    expect(detectMergeConflict("CONFLICT (content): Merge conflict in src/foo.ts")).toBe(true);
  });

  test("returns true when output contains lowercase conflict", () => {
    expect(detectMergeConflict("Auto-merging failed due to conflict in file")).toBe(true);
  });

  test("returns true for typical git merge CONFLICT output", () => {
    const output = [
      "Auto-merging src/index.ts",
      "CONFLICT (content): Merge conflict in src/index.ts",
      "Automatic merge failed; fix conflicts and then commit the result.",
    ].join("\n");
    expect(detectMergeConflict(output)).toBe(true);
  });

  test("returns true for git rebase CONFLICT output", () => {
    const output = "CONFLICT (modify/delete): src/bar.ts deleted in HEAD";
    expect(detectMergeConflict(output)).toBe(true);
  });

  test("returns false when output has no conflict markers", () => {
    expect(detectMergeConflict("All changes committed successfully.")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(detectMergeConflict("")).toBe(false);
  });

  test("returns false for unrelated git output", () => {
    const output = "3 files changed, 10 insertions(+), 2 deletions(-)";
    expect(detectMergeConflict(output)).toBe(false);
  });

  test("returns true when CONFLICT appears in stderr portion of combined output", () => {
    const combined = "stdout: commit abc123\nstderr: CONFLICT detected in merge";
    expect(detectMergeConflict(combined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// captureOutputFiles (ENH-005)
// ---------------------------------------------------------------------------

function mockSpawnOutput(output: string, exitCode = 0) {
  return mock((_args: string[], _opts: unknown) => {
    const bytes = new TextEncoder().encode(output);
    return {
      stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      stderr: new ReadableStream({ start(c) { c.close(); } }),
      exited: Promise.resolve(exitCode),
      kill: mock(() => {}),
    };
  });
}

let origSpawn: typeof _gitDeps.spawn;

beforeEach(() => {
  origSpawn = _gitDeps.spawn;
});

afterEach(() => {
  _gitDeps.spawn = origSpawn;
  mock.restore();
});

describe("captureOutputFiles", () => {
  test("returns empty array when baseRef is undefined", async () => {
    const result = await captureOutputFiles("/tmp/repo", undefined);
    expect(result).toEqual([]);
  });

  test("returns files from git diff when baseRef is set", async () => {
    _gitDeps.spawn = mockSpawnOutput("src/index.ts\nsrc/utils.ts\n");
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual(["src/index.ts", "src/utils.ts"]);
  });

  test("passes baseRef in diff args", async () => {
    let capturedArgs: string[] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      capturedArgs = args as string[];
      const bytes = new TextEncoder().encode("src/a.ts\n");
      return {
        stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });
    await captureOutputFiles("/tmp/repo", "abc123");
    expect(capturedArgs).toContain("abc123..HEAD");
  });

  test("scopes to scopePrefix when provided", async () => {
    let capturedArgs: string[] = [];
    _gitDeps.spawn = mock((args: string[], _opts: unknown) => {
      capturedArgs = args as string[];
      const bytes = new TextEncoder().encode("apps/api/src/index.ts\n");
      return {
        stdout: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
        exited: Promise.resolve(0),
        kill: mock(() => {}),
      };
    });
    const result = await captureOutputFiles("/tmp/repo", "abc123", "apps/api");
    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("apps/api/");
    expect(result).toEqual(["apps/api/src/index.ts"]);
  });

  test("returns empty array on git spawn failure (non-fatal)", async () => {
    _gitDeps.spawn = mock(() => { throw new Error("git not found"); });
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual([]);
  });

  test("filters out empty lines from output", async () => {
    _gitDeps.spawn = mockSpawnOutput("\nsrc/a.ts\n\nsrc/b.ts\n\n");
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("returns empty array when git diff produces no output", async () => {
    _gitDeps.spawn = mockSpawnOutput("");
    const result = await captureOutputFiles("/tmp/repo", "abc123");
    expect(result).toEqual([]);
  });
});


