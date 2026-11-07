/**
 * captureDiffSummary (MED-04).
 *
 * The blocked-worktree suites that shared this file went with the guard itself:
 * the mutation spot-check that populated the blocked-worktree set was deleted
 * (US-005), and the refusal that read the set was deleted with it (US-004) —
 * nothing adds to the set, so the refusal could never fire.
 *
 * `captureDiffSummary` stays here; it shares the same `_gitDeps.spawn`
 * save/restore hook, so it lives under one file.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _gitDeps, captureDiffSummary } from "@/utils/git";

let origSpawn: typeof _gitDeps.spawn;

beforeEach(() => {
  origSpawn = _gitDeps.spawn;
});

afterEach(() => {
  _gitDeps.spawn = origSpawn;
  mock.restore();
});

function mockSpawnOutput(output: string, exitCode = 0): typeof _gitDeps.spawn {
  return makeSpawn(() => ({ stdout: output, exitCode })).spawn;
}

describe("captureDiffSummary", () => {
  test("returns empty string when baseRef is undefined", async () => {
    const result = await captureDiffSummary("/tmp/repo", undefined);
    expect(result).toEqual("");
  });

  test("returns the diff --stat output when baseRef is set", async () => {
    _gitDeps.spawn = mockSpawnOutput("src/index.ts | 3 +-\n1 file changed, 2 insertions(+), 1 deletion(-)\n");
    const result = await captureDiffSummary("/tmp/repo", "abc123");
    expect(result).toContain("src/index.ts");
  });

  test("scopes to scopePrefix when provided", async () => {
    let capturedArgs: string[] = [];
    _gitDeps.spawn = makeSpawn((call) => {
      capturedArgs = call.cmd;
      return "apps/api/src/index.ts | 1 +\n";
    }).spawn;
    await captureDiffSummary("/tmp/repo", "abc123", "apps/api");
    expect(capturedArgs).toContain("--");
    expect(capturedArgs).toContain("apps/api/");
  });

  test("returns empty string on git spawn failure (non-fatal)", async () => {
    _gitDeps.spawn = mock(() => {
      throw new Error("git not found");
    });
    const result = await captureDiffSummary("/tmp/repo", "abc123");
    expect(result).toEqual("");
  });

  // MED-04: captureDiffSummary previously spawned raw git with no deadline —
  // now routes through gitWithTimeout (same _gitDeps.spawn injection point).
  // A non-zero exit now correctly discards stray stdout instead of
  // returning it as a summary.
  test("MED-04: discards stdout when git diff --stat exits non-zero", async () => {
    _gitDeps.spawn = mockSpawnOutput("src/stale.ts | 1 +\n", 128);
    const result = await captureDiffSummary("/tmp/repo", "abc123");
    expect(result).toEqual("");
  });

  test("caps output at 30 lines", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `file${i}.ts | 1 +`);
    _gitDeps.spawn = mockSpawnOutput(`${lines.join("\n")}\n`);
    const result = await captureDiffSummary("/tmp/repo", "abc123");
    expect(result.split("\n").length).toBeLessThanOrEqual(30);
    expect(result).toContain("more files");
  });
});
