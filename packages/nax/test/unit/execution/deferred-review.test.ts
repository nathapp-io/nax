/**
 * Unit tests for deferred plugin review (DR-003)
 *
 * Covers:
 * - captureRunStartRef(): records HEAD git ref
 * - runDeferredReview(): skips when pluginMode is not "deferred"
 * - runDeferredReview(): skips when no reviewers registered
 * - runDeferredReview(): calls each reviewer once with full diff from run-start ref
 * - runDeferredReview(): failures log warning but do NOT throw
 * - runDeferredReview(): returns result with anyFailed flag and reviewer outputs
 * - SequentialExecutionResult includes optional deferredReview field
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeConfigSlice, makePluginRegistry, makePRD, makeSpawn, withDepsRestore } from "@test/helpers";
import { _deferredReviewDeps, captureRunStartRef, runDeferredReview } from "@/execution/deferred-review";
import type { PluginRegistry } from "@/plugins";
import type { IReviewPlugin } from "@/plugins/extensions";
import type { ReviewConfig } from "@/review/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_REF = "abc1234def5678901234567890123456789abcde";

function makeSpawnForRef(ref: string) {
  return makeSpawn(() => `${ref}\n`).spawn;
}

function makeSpawnForDiff(files: string[]) {
  return makeSpawn(() => files.join("\n")).spawn;
}

function makeReviewer(name: string, passed = true): IReviewPlugin {
  return {
    name,
    description: `Test reviewer: ${name}`,
    check: mock(async (_workdir: string, _files: string[]) => ({
      passed,
      output: passed ? "" : `findings from ${name}`,
      exitCode: passed ? 0 : 1,
    })),
  };
}

function makeRegistry(reviewers: IReviewPlugin[]): PluginRegistry {
  return makePluginRegistry({ getReviewers: mock(() => reviewers) });
}

// Note: pluginMode is a separate axis (observational|gating, ADR-023) that
// runDeferredReview does not read — it always runs when reviewers are
// registered. The "deferred"/"per-story" labels this helper used to accept
// described a mode that no longer exists.
function makeReviewConfig(): ReviewConfig {
  return makeConfigSlice("review", { enabled: true, checks: [], commands: {} });
}

withDepsRestore(_deferredReviewDeps, ["spawn"]);
afterEach(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// captureRunStartRef
// ─────────────────────────────────────────────────────────────────────────────

describe("captureRunStartRef — captures HEAD git ref before stories run", () => {
  test("returns current HEAD ref via git rev-parse", async () => {
    _deferredReviewDeps.spawn = makeSpawnForRef(FAKE_REF);

    const ref = await captureRunStartRef("/tmp/workdir");

    expect(ref).toBe(FAKE_REF);
  });

  test("invokes git rev-parse HEAD in the provided workdir", async () => {
    const spawnMock = makeSpawnForRef(FAKE_REF);
    _deferredReviewDeps.spawn = spawnMock;

    await captureRunStartRef("/tmp/my-workdir");

    expect(spawnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: ["git", "rev-parse", "HEAD"],
        cwd: "/tmp/my-workdir",
      }),
    );
  });

  test("trims whitespace/newline from git output", async () => {
    _deferredReviewDeps.spawn = makeSpawnForRef(`  ${FAKE_REF}  \n`);

    const ref = await captureRunStartRef("/tmp/workdir");

    expect(ref).toBe(FAKE_REF);
  });

  test("returns empty string when git command fails", async () => {
    _deferredReviewDeps.spawn = makeSpawn(() => {
      throw new Error("git not found");
    }).spawn;

    const ref = await captureRunStartRef("/tmp/workdir");

    expect(ref).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDeferredReview — guard conditions
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredReview — skips when conditions are not met", () => {
  test("returns undefined when no plugin reviewers are registered", async () => {
    const registry = makeRegistry([]);

    const result = await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    expect(result).toBeUndefined();
  });

  test("returns undefined when pluginMode is 'deferred' but registry has no reviewers", async () => {
    const registry = makeRegistry([]);
    const spawnMock = makeSpawnForDiff([]);
    _deferredReviewDeps.spawn = spawnMock;

    const result = await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    expect(result).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDeferredReview — successful execution
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredReview — runs reviewers with full diff when deferred", () => {
  beforeEach(() => {
    _deferredReviewDeps.spawn = makeSpawnForDiff(["src/foo.ts", "src/bar.ts"]);
  });

  test("calls each registered reviewer exactly once", async () => {
    const reviewer1 = makeReviewer("semgrep");
    const reviewer2 = makeReviewer("license-check");
    const registry = makeRegistry([reviewer1, reviewer2]);

    await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    expect(reviewer1.check).toHaveBeenCalledTimes(1);
    expect(reviewer2.check).toHaveBeenCalledTimes(1);
  });

  test("passes workdir and changed files to each reviewer", async () => {
    const reviewer = makeReviewer("semgrep");
    const registry = makeRegistry([reviewer]);

    await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    expect(reviewer.check).toHaveBeenCalledWith("/tmp/workdir", expect.arrayContaining(["src/foo.ts", "src/bar.ts"]));
  });

  test("uses run-start ref as baseRef for git diff (full diff range)", async () => {
    const spawnMock = makeSpawnForDiff(["src/changed.ts"]);
    _deferredReviewDeps.spawn = spawnMock;

    const reviewer = makeReviewer("semgrep");
    const registry = makeRegistry([reviewer]);

    await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    // Verify spawn was called with a diff command using the run-start ref
    const calls = (spawnMock as ReturnType<typeof mock>).mock.calls;
    const diffCall = calls.find((call) => {
      const cmd = (call[0] as { cmd: string[] }).cmd;
      return cmd.includes("diff") && cmd.some((arg: string) => arg.includes(FAKE_REF));
    });
    expect(diffCall).toBeDefined();
  });

  test("returns result with reviewer outputs and anyFailed=false when all pass", async () => {
    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);

    const result = await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    assertDefined(result, "runDeferredReview result");
    expect(result.anyFailed).toBe(false);
    expect(result.reviewerResults).toHaveLength(1);
    expect(result.reviewerResults[0].name).toBe("semgrep");
    expect(result.reviewerResults[0].passed).toBe(true);
  });

  test("returns result with anyFailed=true when a reviewer fails", async () => {
    const reviewer = makeReviewer("semgrep", false);
    const registry = makeRegistry([reviewer]);

    const result = await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    assertDefined(result, "runDeferredReview result");
    expect(result.anyFailed).toBe(true);
    expect(result.reviewerResults[0].passed).toBe(false);
  });

  test("includes runStartRef in the returned result", async () => {
    const reviewer = makeReviewer("semgrep");
    const registry = makeRegistry([reviewer]);

    const result = await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    assertDefined(result, "runDeferredReview result");
    expect(result.runStartRef).toBe(FAKE_REF);
  });

  test("continues running remaining reviewers when one fails (does not short-circuit)", async () => {
    const reviewer1 = makeReviewer("semgrep", false);
    const reviewer2 = makeReviewer("license-check", true);
    const registry = makeRegistry([reviewer1, reviewer2]);

    const result = await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    // Both reviewers should run even though first one failed
    expect(reviewer1.check).toHaveBeenCalledTimes(1);
    expect(reviewer2.check).toHaveBeenCalledTimes(1);
    assertDefined(result, "runDeferredReview result");
    expect(result.reviewerResults).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDeferredReview — reviewer throws (error resilience)
// ─────────────────────────────────────────────────────────────────────────────

describe("runDeferredReview — plugin failures do NOT fail the run", () => {
  beforeEach(() => {
    _deferredReviewDeps.spawn = makeSpawnForDiff(["src/foo.ts"]);
  });

  test("does NOT throw when a reviewer throws an exception", async () => {
    const failingReviewer: IReviewPlugin = {
      name: "crashing-reviewer",
      description: "A reviewer that throws",
      check: mock(async () => {
        throw new Error("reviewer crashed");
      }),
    };
    const registry = makeRegistry([failingReviewer]);

    // Must not throw
    await expect(runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF)).resolves.toBeDefined();
  });

  test("records error in reviewer result when reviewer throws", async () => {
    const failingReviewer: IReviewPlugin = {
      name: "crashing-reviewer",
      description: "A reviewer that throws",
      check: mock(async () => {
        throw new Error("reviewer crashed");
      }),
    };
    const registry = makeRegistry([failingReviewer]);

    const result = await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    assertDefined(result, "runDeferredReview result");
    expect(result.anyFailed).toBe(true);
    expect(result.reviewerResults[0].passed).toBe(false);
    expect(result.reviewerResults[0].error).toContain("reviewer crashed");
  });

  test("continues running remaining reviewers when one throws", async () => {
    const failingReviewer: IReviewPlugin = {
      name: "crashing",
      description: "Throws",
      check: mock(async () => {
        throw new Error("crash");
      }),
    };
    const passingReviewer = makeReviewer("passing", true);
    const registry = makeRegistry([failingReviewer, passingReviewer]);

    const result = await runDeferredReview("/tmp/workdir", makeReviewConfig(), registry, FAKE_REF);

    expect(passingReviewer.check).toHaveBeenCalledTimes(1);
    assertDefined(result, "runDeferredReview result");
    expect(result.reviewerResults).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SequentialExecutionResult — deferredReview field
// ─────────────────────────────────────────────────────────────────────────────

describe("SequentialExecutionResult — includes optional deferredReview field", () => {
  test("SequentialExecutionResult type accepts deferredReview field", () => {
    // Type-level check: if this compiles, the type has the field
    const result: import("@/execution/executor-types").SequentialExecutionResult = {
      prd: makePRD({ feature: "test", userStories: [] }),
      iterations: 1,
      storiesCompleted: 1,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
      deferredReview: {
        runStartRef: FAKE_REF,
        changedFiles: ["src/foo.ts"],
        reviewerResults: [{ name: "semgrep", passed: true, output: "" }],
        anyFailed: false,
      },
    };

    const dr = result.deferredReview;
    assertDefined(dr, "result.deferredReview");
    expect(dr.runStartRef).toBe(FAKE_REF);
  });

  test("SequentialExecutionResult allows deferredReview to be undefined", () => {
    const result: import("@/execution/executor-types").SequentialExecutionResult = {
      prd: makePRD({ feature: "test", userStories: [] }),
      iterations: 1,
      storiesCompleted: 1,
      totalCost: 0,
      allStoryMetrics: [],
      exitReason: "completed",
    };

    expect(result.deferredReview).toBeUndefined();
  });
});
