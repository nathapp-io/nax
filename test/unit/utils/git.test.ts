/**
 * Unit tests for git utility functions (TC-003)
 *
 * Covers: detectMergeConflict helper, captureOutputFiles helper (ENH-005)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _gitDeps, captureOutputFiles, detectMergeConflict } from "@/utils/git";

describe("detectMergeConflict", () => {
  // True positives — real git conflict signals
  test.each([
    ["CONFLICT (content): marker", "CONFLICT (content): Merge conflict in src/foo.ts"],
    ["CONFLICT (modify/delete) rebase output", "CONFLICT (modify/delete): src/bar.ts deleted in HEAD"],
    ["<<<<<<< conflict marker", "<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> feature"],
    [">>>>>>> conflict marker", ">>>>>>> feature-branch"],
    ["Merge conflict in <file> message", "Merge conflict in src/index.ts"],
    ["typical merge output with CONFLICT", "Auto-merging src/index.ts\nCONFLICT (content): Merge conflict in src/index.ts\nAutomatic merge failed; fix conflicts and then commit the result."],
    ["combined stderr output", "stdout: commit abc123\nstderr: CONFLICT (content): Merge conflict in src/foo.ts"],
  ])("returns true for %s", (_label, output) => {
    expect(detectMergeConflict(output)).toBe(true);
  });

  // False positives — words that must NOT trigger the detector
  test.each([
    ["bare lowercase 'conflict'", "Auto-merging failed due to conflict in file"],
    ["HTTP 409 Conflict in agent output", "throw new HttpException('HTTP 409 Conflict: duplicate connection', 409)"],
    ["'already-synced conflict' wording", "// return 409 when there is a duplicate conflict"],
    ["CONFLICT without parenthesised type", "stderr: CONFLICT detected in merge"],
    ["no conflict markers", "All changes committed successfully."],
    ["empty string", ""],
    ["unrelated git output", "3 files changed, 10 insertions(+), 2 deletions(-)"],
  ])("returns false for %s", (_label, output) => {
    expect(detectMergeConflict(output)).toBe(false);
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


