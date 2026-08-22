/**
 * Unit tests for src/review/diff-utils.ts
 *
 * Covers:
 * - resolveEffectiveRef: valid ref, merge-base fallback, both-invalid undefined
 * - collectDiff: correct spawn args, non-zero exit returns ""
 * - collectDiffStat: --stat flag passed to spawn
 * - truncateDiff: passthrough under cap, truncation with stat preamble
 * - computeTestInventory: test file classification, untested source detection, non-zero exit
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  DIFF_CAP_BYTES,
  _diffUtilsDeps,
  collectDiff,
  collectDiffFileList,
  collectDiffStat,
  computeTestInventory,
  resolveEffectiveRef,
  truncateDiff,
} from "@/review";

// ─── Mock helpers ──────────────────────────────────────────────────────────────

/** Build a mock spawn that returns the provided stdout with the given exit code. */
function makeSpawnMock(stdout: string, exitCode = 0) {
  return mock((_opts: unknown) => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

/** Build a mock spawn that captures cmd args and returns stdout. */
function makeCapturingSpawnMock(stdout: string, capturedCmd: { value?: string[] }) {
  return mock((opts: unknown) => {
    capturedCmd.value = (opts as { cmd: string[] }).cmd;
    return {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stdout));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      kill: () => {},
    };
  }) as unknown as typeof _diffUtilsDeps.spawn;
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

// ─── collectDiff ──────────────────────────────────────────────────────────────

describe("collectDiff()", () => {
  test("calls spawn with correct args: ref..HEAD, excludePatterns, and always-excluded paths", async () => {
    const captured: { value?: string[] } = {};
    _diffUtilsDeps.spawn = makeCapturingSpawnMock("diff output", captured);

    await collectDiff("/repo", "abc123", [":!test/"]);

    expect(captured.value).toBeDefined();
    expect(captured.value).toContain("git");
    expect(captured.value).toContain("diff");
    expect(captured.value).toContain("abc123..HEAD");
    expect(captured.value).toContain(":!test/");
    // Always-excluded paths
    expect(captured.value).toContain(":!.nax/");
    expect(captured.value).toContain(":!.nax-pids");
  });

  test("returns stdout string on exit code 0; null on non-zero", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("diff content");
    expect(await collectDiff("/repo", "abc123", [])).toBe("diff content");

    _diffUtilsDeps.spawn = makeSpawnMock("some output", 1);
    expect(await collectDiff("/repo", "abc123", [])).toBeNull();
  });
});

// ─── collectDiffStat ──────────────────────────────────────────────────────────

describe("collectDiffStat()", () => {
  test("calls spawn with --stat flag", async () => {
    const captured: { value?: string[] } = {};
    _diffUtilsDeps.spawn = makeCapturingSpawnMock("stat output", captured);

    await collectDiffStat("/repo", "abc123");

    expect(captured.value).toBeDefined();
    expect(captured.value).toContain("--stat");
    expect(captured.value).toContain("abc123..HEAD");
  });

  test("returns trimmed stdout on success; empty string on non-zero exit code", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("  stat output  ");
    expect(await collectDiffStat("/repo", "abc123")).toBe("stat output");

    _diffUtilsDeps.spawn = makeSpawnMock("stat output", 2);
    expect(await collectDiffStat("/repo", "abc123")).toBe("");
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
    const largeDiff = "diff --git a/foo.ts b/foo.ts\n" + "x".repeat(DIFF_CAP_BYTES + 1000);

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

// ─── computeTestInventory ─────────────────────────────────────────────────────

describe("computeTestInventory()", () => {
  test("classifies .test.ts and .spec.ts files as addedTestFiles", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("src/foo/bar.ts\ntest/unit/foo/bar.test.ts\n");
    expect((await computeTestInventory("/repo", "abc123")).addedTestFiles).toContain("test/unit/foo/bar.test.ts");

    _diffUtilsDeps.spawn = makeSpawnMock("src/utils.ts\nsrc/utils.spec.ts\n");
    expect((await computeTestInventory("/repo", "abc123")).addedTestFiles).toContain("src/utils.spec.ts");
  });

  test("classifies source files with no matching test as newSourceFilesWithoutTests", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("src/foo/orphan.ts\n");

    const result = await computeTestInventory("/repo", "abc123");

    expect(result.newSourceFilesWithoutTests).toContain("src/foo/orphan.ts");
  });

  test("does not flag source file as untested when a matching test file was added", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("src/foo/bar.ts\ntest/unit/foo/bar.test.ts\n");

    const result = await computeTestInventory("/repo", "abc123");

    expect(result.newSourceFilesWithoutTests).not.toContain("src/foo/bar.ts");
  });

  test("returns empty arrays on non-zero exit code", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("src/foo/bar.ts\n", 1);

    const result = await computeTestInventory("/repo", "abc123");

    expect(result.addedTestFiles).toHaveLength(0);
    expect(result.newSourceFilesWithoutTests).toHaveLength(0);
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
// deadline so collectDiff resolves with null rather than blocking forever.
describe("collectDiff() — BUG-31: hung git returns rather than blocking", () => {
  /**
   * The SIGKILL deadline under test, shrunk from the production GIT_TIMEOUT_MS
   * (10s) so the hang path costs milliseconds instead of ten seconds. The
   * contract exercised is identical — the timer fires, git is SIGKILLed, and
   * collectDiff resolves null — and the tightened bound below is strictly
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

  test("returns null within the deadline when proc.exited never resolves", async () => {
    const hungSpawn = mock((_opts: unknown) => ({
      // Promise that never resolves — the timeout must save us.
      exited: new Promise<number>(() => {}),
      stdout: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      kill: () => {},
    })) as unknown as typeof _diffUtilsDeps.spawn;
    _diffUtilsDeps.spawn = hungSpawn;

    const start = Date.now();
    const out = await collectDiff("/workdir", "abc123", []);
    const elapsed = Date.now() - start;

    expect(out).toBeNull();
    // Assert the call returned on the timeout path rather than blocking
    // indefinitely (pre-fix: hangs forever on the never-resolving `exited`).
    expect(elapsed).toBeLessThan(1_000);
  });
});
