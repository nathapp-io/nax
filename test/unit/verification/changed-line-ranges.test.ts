/**
 * Unit tests for getChangedLineRanges — US-002 fetcher.
 *
 * Covers the 9 acceptance criteria: result type, default ref, exit code / throw
 * failure paths, empty-output behaviour, and absolute-key anchoring against the
 * resolved git root.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as path from "node:path";
import { _gitDeps } from "@/utils/git";
import { _changedLineRangesDeps, getChangedLineRanges } from "@/verification/changed-line-ranges";
import { makeSpawn, withDepsRestore } from "@test/helpers";

describe("getChangedLineRanges", () => {
  withDepsRestore(_gitDeps, ["spawn"]);

  let origGetGitRoot: typeof _changedLineRangesDeps.getGitRoot;

  beforeEach(() => {
    origGetGitRoot = _changedLineRangesDeps.getGitRoot;
    // Default: git root lookup returns null so tests opt-in to non-null anchoring.
    _changedLineRangesDeps.getGitRoot = mock(async (_wd: string) => null);
  });

  afterEach(() => {
    _changedLineRangesDeps.getGitRoot = origGetGitRoot;
    mock.restore();
  });

  // ---------------------------------------------------------------------------
  // AC1 — successful git response resolves to a Map
  // ---------------------------------------------------------------------------

  test("AC1: resolves to a Map on successful git response", async () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-x
+y
`;
    _gitDeps.spawn = makeSpawn(() => diff).spawn;

    const result = await getChangedLineRanges("/workdir");
    expect(result).toBeInstanceOf(Map);
  });

  // ---------------------------------------------------------------------------
  // AC2 — explicit baseRef flows into git args in expected order
  // ---------------------------------------------------------------------------

  test('AC2: passes ["diff", "--unified=0", baseRef] in order to git runner', async () => {
    let capturedArgs: string[] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      capturedArgs = cmd;
      return "";
    }).spawn;

    await getChangedLineRanges("/workdir", "abc123");

    expect(capturedArgs).toEqual(["git", "diff", "--unified=0", "abc123"]);
  });

  // ---------------------------------------------------------------------------
  // AC3 — no baseRef defaults to HEAD~1
  // ---------------------------------------------------------------------------

  test("AC3: defaults baseRef to HEAD~1 when not provided", async () => {
    let capturedArgs: string[] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      capturedArgs = cmd;
      return "";
    }).spawn;

    await getChangedLineRanges("/workdir");

    expect(capturedArgs).toEqual(["git", "diff", "--unified=0", "HEAD~1"]);
  });

  // ---------------------------------------------------------------------------
  // AC4 — non-zero exit code resolves to null
  // ---------------------------------------------------------------------------

  test("AC4: resolves to null on non-zero git exit code", async () => {
    _gitDeps.spawn = makeSpawn(() => ({ exitCode: 128, stdout: "" })).spawn;

    const result = await getChangedLineRanges("/workdir", "abc123");
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // AC5 — thrown spawn resolves to null (fail-open)
  // ---------------------------------------------------------------------------

  test("AC5: resolves to null when git runner throws", async () => {
    _gitDeps.spawn = makeSpawn(() => {
      throw new Error("spawn failed");
    }).spawn;

    const result = await getChangedLineRanges("/workdir", "abc123");
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // AC6 — successful git response with empty stdout yields empty Map
  // ---------------------------------------------------------------------------

  test("AC6: resolves to an empty Map (not null) on empty stdout", async () => {
    _gitDeps.spawn = makeSpawn(() => "").spawn;

    const result = await getChangedLineRanges("/workdir", "abc123");
    expect(result).toBeInstanceOf(Map);
    expect(result?.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // AC7 — paths anchored at resolved git root
  // ---------------------------------------------------------------------------

  test("AC7: keys returned are rooted at the resolved git root", async () => {
    _changedLineRangesDeps.getGitRoot = mock(async (_wd: string) => "/repo");
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-x
+y
`;
    _gitDeps.spawn = makeSpawn(() => diff).spawn;

    const result = await getChangedLineRanges("/workdir", "abc123");
    expect(result).not.toBeNull();
    expect(result?.has("/repo/src/a.ts")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC8 — null git root falls back to workdir
  // ---------------------------------------------------------------------------

  test("AC8: keys are rooted at workdir when git root lookup returns null", async () => {
    _changedLineRangesDeps.getGitRoot = mock(async (_wd: string) => null);
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-x
+y
`;
    _gitDeps.spawn = makeSpawn(() => diff).spawn;

    const result = await getChangedLineRanges("/workdir", "abc123");
    expect(result).not.toBeNull();
    expect(result?.has("/workdir/src/a.ts")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // AC9 — hunk header parsing into LineRange
  // ---------------------------------------------------------------------------

  test("AC9: parses @@ -0,0 +2,3 @@ into { start: 2, end: 4 }", async () => {
    _changedLineRangesDeps.getGitRoot = mock(async (_wd: string) => "/repo");
    const diff = `diff --git a/src/a.ts b/src/a.ts
new file mode 100644
--- /dev/null
+++ b/src/a.ts
@@ -0,0 +2,3 @@
+line1
+line2
+line3
`;
    _gitDeps.spawn = makeSpawn(() => diff).spawn;

    const result = await getChangedLineRanges("/workdir", "abc123");
    expect(result).not.toBeNull();
    expect(result?.get("/repo/src/a.ts")).toEqual([{ start: 2, end: 4 }]);
  });

  // ---------------------------------------------------------------------------
  // Regression — review warning: string concatenation produced non-normalized
  // keys when the anchor had a trailing slash or the workdir was relative.
  // ---------------------------------------------------------------------------

  test("normalizes trailing slash on git root so keys are not double-slashed", async () => {
    _changedLineRangesDeps.getGitRoot = mock(async (_wd: string) => "/repo/");
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-x
+y
`;
    _gitDeps.spawn = makeSpawn(() => diff).spawn;

    const result = await getChangedLineRanges("/workdir", "abc123");
    expect(result).not.toBeNull();
    expect(result?.has("/repo/src/a.ts")).toBe(true);
    expect(result?.has("/repo//src/a.ts")).toBe(false);
  });

  test("absolutizes a relative workdir fallback so keys are absolute paths", async () => {
    _changedLineRangesDeps.getGitRoot = mock(async (_wd: string) => null);
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
-x
+y
`;
    _gitDeps.spawn = makeSpawn(() => diff).spawn;

    const result = await getChangedLineRanges("relative/workdir", "abc123");
    expect(result).not.toBeNull();
    expect(result).not.toBeNull();
    const keys = Array.from(result!.keys());
    expect(keys).toHaveLength(1);
    expect(path.isAbsolute(keys[0]!)).toBe(true);
    expect(keys[0]).toMatch(/relative[/\\]workdir[/\\]src[/\\]a\.ts$/);
  });
});
