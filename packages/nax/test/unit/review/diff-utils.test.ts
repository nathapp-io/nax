/**
 * Unit tests for src/review/diff-utils.ts
 *
 * Covers:
 * - resolveEffectiveRef: valid ref, merge-base fallback, both-invalid undefined
 * - truncateDiff: passthrough under cap, truncation with stat preamble
 * - collectDiffFileList: parsed file list, no output, git failure, BUG-31 timeout
 *
 * The embedded-diff collectors (`collectDiff`, `collectDiffStat`) and
 * `computeTestInventory` were deleted with the embedded-diff prompt path in
 * US-003 (pipeline-review-delete); `collectDiffFileList` is the surviving
 * collector and carries the BUG-31 hung-git deadline assertions with it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { _diffUtilsDeps, collectDiffFileList, DIFF_CAP_BYTES, resolveEffectiveRef, truncateDiff } from "@/review";

// ─── Mock helpers ──────────────────────────────────────────────────────────────

/** Build a mock spawn that returns the provided stdout with the given exit code. */
function makeSpawnMock(stdout: string, exitCode = 0) {
  return makeSpawn(() => ({ exitCode, stdout })).spawn;
}

// ─── Dep originals ─────────────────────────────────────────────────────────────

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

beforeEach(() => {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;

  // Default stubs — individual tests override as needed
  _diffUtilsDeps.spawn = makeSpawnMock("");
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
});

afterEach(() => {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
});

// ─── resolveEffectiveRef ───────────────────────────────────────────────────────

describe("resolveEffectiveRef()", () => {
  test("returns supplied ref when isGitRefValid returns true", async () => {
    _diffUtilsDeps.isGitRefValid = mock(async () => true);

    const result = await resolveEffectiveRef("/repo", "abc123", "STORY-001");

    expect(result).toBe("abc123");
  });

  test("falls back to merge-base when supplied ref is invalid", async () => {
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => "merge-base-sha");

    const result = await resolveEffectiveRef("/repo", "bad-ref", "STORY-001");

    expect(result).toBe("merge-base-sha");
  });

  test("returns undefined when ref is invalid and no merge-base exists", async () => {
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);

    const result = await resolveEffectiveRef("/repo", "bad-ref", "STORY-001");

    expect(result).toBeUndefined();
  });

  test("returns merge-base when storyGitRef is undefined", async () => {
    _diffUtilsDeps.getMergeBase = mock(async () => "merge-base-sha");

    const result = await resolveEffectiveRef("/repo", undefined, "STORY-001");

    expect(result).toBe("merge-base-sha");
  });
});

// ─── truncateDiff ─────────────────────────────────────────────────────────────

describe("truncateDiff()", () => {
  test("returns diff unchanged when under DIFF_CAP_BYTES", () => {
    const smallDiff = "diff --git a/foo.ts b/foo.ts\n+export const x = 1;";

    const result = truncateDiff(smallDiff);

    expect(result).toBe(smallDiff);
  });

  test("truncates when over DIFF_CAP_BYTES; includes stat preamble when provided; omits when absent", () => {
    const largeDiff = `diff --git a/foo.ts b/foo.ts\n${"x".repeat(DIFF_CAP_BYTES + 1000)}`;

    const noStat = truncateDiff(largeDiff);
    expect(noStat.length).toBeLessThan(largeDiff.length);
    expect(noStat).toContain("truncated");
    expect(noStat).not.toContain("File Summary");

    const stat = "foo.ts | 10 ++++++++++";
    const withStat = truncateDiff(largeDiff, stat);
    expect(withStat).toContain("File Summary");
    expect(withStat).toContain(stat);
  });
});

describe("collectDiffFileList", () => {
  test("returns parsed file list on git success", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("src/a.ts\nsrc/b.ts\n", 0);
    const files = await collectDiffFileList("/tmp/repo", "abc123");
    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("returns empty array on no output; undefined on failure; trims and skips empty lines", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    expect(await collectDiffFileList("/tmp/repo", "abc123")).toEqual([]);

    _diffUtilsDeps.spawn = makeSpawnMock("", 128);
    expect(await collectDiffFileList("/tmp/repo", "abc123")).toBeUndefined();

    _diffUtilsDeps.spawn = makeSpawnMock("src/a.ts\n\nsrc/b.ts\n  \n", 0);
    expect(await collectDiffFileList("/tmp/repo", "abc123")).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

// BUG-31: a hung git (NFS / lock contention) must not stall the review
// stage indefinitely. The runGitWithTimeout wrapper applies a SIGKILL
// deadline so the collector resolves rather than blocking forever; it covers
// both surviving collectors, so the deadline is pinned on the survivor after
// `collectDiff` went with the embedded-diff prompt path (US-003).
describe("collectDiffFileList() — BUG-31: hung git returns rather than blocking", () => {
  /**
   * The SIGKILL deadline under test, shrunk from the production GIT_TIMEOUT_MS
   * (10s) so the hang path costs milliseconds instead of ten seconds. The
   * contract exercised is identical — the timer fires, git is SIGKILLed, and
   * the collector resolves — and the tightened bound below is strictly
   * stronger than the 60s one it replaces.
   */
  const TEST_TIMEOUT_MS = 50;

  let origTimeout: number;

  beforeEach(() => {
    origTimeout = _diffUtilsDeps.timeoutMs;
    _diffUtilsDeps.timeoutMs = TEST_TIMEOUT_MS;
  });

  afterEach(() => {
    _diffUtilsDeps.timeoutMs = origTimeout;
  });

  test("returns undefined within the deadline when proc.exited never resolves", async () => {
    const hungSpawn = makeSpawn(() => ({
      // Promise that never resolves — the timeout must save us.
      hang: true,
    })).spawn;
    _diffUtilsDeps.spawn = hungSpawn;

    const start = Date.now();
    const out = await collectDiffFileList("/workdir", "abc123");
    const elapsed = Date.now() - start;

    // `undefined` is the collector's "git failed" result: the deadline fired,
    // so the caller degrades instead of treating a wedged git as "no changes".
    expect(out).toBeUndefined();
    // Assert the call returned on the timeout path rather than blocking
    // indefinitely (pre-fix: hangs forever on the never-resolving `exited`).
    expect(elapsed).toBeLessThan(1_000);
  });
});
