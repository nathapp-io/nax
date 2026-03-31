/**
 * Unit tests for runReplanLoop (US-003)
 *
 * Tests the replan loop inserted after planCommand() in nax run --plan.
 * The loop decomposes oversized stories and re-runs precheck until all pass
 * or maxReplanAttempts is exhausted.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _planDeps, runReplanLoop } from "../../../src/cli/plan";
import type { NaxConfig } from "../../../src/config";
import type { PrecheckResultWithCode } from "../../../src/precheck";
import type { FlaggedStory } from "../../../src/precheck/story-size-gate";
import type { PRD } from "../../../src/prd/types";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(action: "block" | "warn" | "skip" = "block", maxReplanAttempts = 3): NaxConfig {
  return {
    precheck: {
      storySizeGate: {
        enabled: true,
        maxAcCount: 10,
        maxDescriptionLength: 3000,
        maxBulletPoints: 12,
        action,
        maxReplanAttempts,
      },
    },
  } as unknown as NaxConfig;
}

function makePrd(storyIds: string[] = ["US-001"]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test-feature",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: storyIds.map((id) => ({
      id,
      title: `Story ${id}`,
      description: "A story description",
      acceptanceCriteria: ["AC-1: When X, then Y"],
      contextFiles: ["src/index.ts"],
      tags: ["feature"],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple" as const,
        testStrategy: "test-after" as const,
        reasoning: "Simple story",
      },
    })),
  };
}

function makeFlaggedStory(storyId: string): FlaggedStory {
  return {
    storyId,
    signals: {
      acCount: { value: 15, threshold: 10, flagged: true },
      descriptionLength: { value: 100, threshold: 3000, flagged: false },
      bulletPoints: { value: 5, threshold: 12, flagged: false },
    },
    recommendation: `Run 'nax plan --decompose ${storyId}'`,
  };
}

function makeBlockedPrecheck(flaggedStoryIds: string[]): PrecheckResultWithCode {
  const blockerCheck = {
    name: "story-size-gate",
    passed: false,
    tier: "blocker" as const,
    message: `${flaggedStoryIds.length} stories exceed size thresholds`,
  };
  return {
    result: { blockers: [blockerCheck], warnings: [] },
    exitCode: 1,
    output: {
      passed: false,
      blockers: [blockerCheck],
      warnings: [],
      summary: { total: 1, passed: 0, failed: 1, warnings: 0 },
      feature: "test-feature",
    },
    flaggedStories: flaggedStoryIds.map(makeFlaggedStory),
  };
}

function makePassingPrecheck(): PrecheckResultWithCode {
  return {
    result: { blockers: [], warnings: [] },
    exitCode: 0,
    output: {
      passed: true,
      blockers: [],
      warnings: [],
      summary: { total: 1, passed: 1, failed: 0, warnings: 0 },
      feature: "test-feature",
    },
    flaggedStories: [],
  };
}

function makeWarnPrecheck(flaggedStoryIds: string[]): PrecheckResultWithCode {
  const warningCheck = {
    name: "story-size-gate",
    passed: false,
    tier: "warning" as const,
    message: `${flaggedStoryIds.length} stories are large (non-blocking)`,
  };
  return {
    result: { blockers: [], warnings: [warningCheck] },
    exitCode: 0,
    output: {
      passed: true, // warnings don't block
      blockers: [],
      warnings: [warningCheck],
      summary: { total: 1, passed: 0, failed: 0, warnings: 1 },
      feature: "test-feature",
    },
    flaggedStories: flaggedStoryIds.map(makeFlaggedStory),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture originals before any test overrides
// ─────────────────────────────────────────────────────────────────────────────

const origRunPrecheck = _planDeps.runPrecheck;
const origProcessExit = _planDeps.processExit;
const origPlanDecompose = _planDeps.planDecompose;
const origReadFile = _planDeps.readFile;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runReplanLoop", () => {
  let tmpDir: string;
  let prd: PRD;
  let prdPath: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-replan-test-");
    prd = makePrd(["US-001"]);
    prdPath = `${tmpDir}/.nax/features/test-feature/prd.json`;

    // Default mocks — override per test as needed
    _planDeps.processExit = mock((_code: number): never => {
      throw new Error(`process.exit(${_code})`);
    }) as never;
    _planDeps.planDecompose = mock(async () => () => {}) as never;
    _planDeps.readFile = mock(async () => JSON.stringify(prd)) as never;
    _planDeps.runPrecheck = mock(async () => makePassingPrecheck()) as never;
  });

  afterEach(() => {
    mock.restore();
    _planDeps.runPrecheck = origRunPrecheck;
    _planDeps.processExit = origProcessExit;
    _planDeps.planDecompose = origPlanDecompose;
    _planDeps.readFile = origReadFile;
    cleanupTempDir(tmpDir);
  });

  // ── AC-6: action === 'warn' — loop does NOT fire ──────────────────────────

  test("AC-6: does not call planDecomposeCommand when storySizeGate action is warn", async () => {
    _planDeps.runPrecheck = mock(async () => makeWarnPrecheck(["US-001"])) as never;

    await runReplanLoop(tmpDir, makeConfig("warn"), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    expect(_planDeps.planDecompose).not.toHaveBeenCalled();
  });

  test("AC-6: does not call processExit when action is warn even with flagged stories", async () => {
    _planDeps.runPrecheck = mock(async () => makeWarnPrecheck(["US-001"])) as never;

    await runReplanLoop(tmpDir, makeConfig("warn"), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    expect(_planDeps.processExit).not.toHaveBeenCalled();
  });

  // ── AC-6: no flagged stories — loop does NOT fire ─────────────────────────

  test("AC-6: does not fire when precheck returns no flagged stories", async () => {
    _planDeps.runPrecheck = mock(async () => makePassingPrecheck()) as never;

    await runReplanLoop(tmpDir, makeConfig("block"), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    expect(_planDeps.planDecompose).not.toHaveBeenCalled();
    expect(_planDeps.processExit).not.toHaveBeenCalled();
  });

  // ── AC-1: calls planDecomposeCommand for each story in flaggedStories ─────

  test("AC-1: calls planDecomposeCommand for each story in flaggedStories", async () => {
    const prd2 = makePrd(["US-001", "US-002"]);
    let callCount = 0;
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount === 1) return makeBlockedPrecheck(["US-001", "US-002"]);
      return makePassingPrecheck();
    }) as never;
    _planDeps.readFile = mock(async () => JSON.stringify(prd2)) as never;

    await runReplanLoop(tmpDir, makeConfig("block"), {
      feature: "test-feature",
      prd: prd2,
      prdPath,
    });

    expect(_planDeps.planDecompose).toHaveBeenCalledTimes(2);
  });

  test("AC-1: passes correct workdir, feature, and storyId to planDecomposeCommand", async () => {
    let callCount = 0;
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount === 1) return makeBlockedPrecheck(["US-001"]);
      return makePassingPrecheck();
    }) as never;

    await runReplanLoop(tmpDir, makeConfig("block"), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    expect(_planDeps.planDecompose).toHaveBeenCalledWith(
      tmpDir,
      expect.anything(),
      { feature: "test-feature", storyId: "US-001" },
    );
  });

  // ── AC-2: PRD reloaded and precheck re-run after each decompose ───────────

  test("AC-2: reads PRD from prdPath after each decompose call", async () => {
    let callCount = 0;
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount === 1) return makeBlockedPrecheck(["US-001"]);
      return makePassingPrecheck();
    }) as never;

    await runReplanLoop(tmpDir, makeConfig("block"), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    expect(_planDeps.readFile).toHaveBeenCalledWith(prdPath);
  });

  test("AC-2: re-runs runPrecheck with the reloaded PRD after decompose", async () => {
    let callCount = 0;
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount === 1) return makeBlockedPrecheck(["US-001"]);
      return makePassingPrecheck();
    }) as never;

    await runReplanLoop(tmpDir, makeConfig("block"), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    // At least: initial check + one recheck after decompose
    expect(_planDeps.runPrecheck).toHaveBeenCalledTimes(2);
  });

  // ── AC-3: exits early when flaggedStories becomes empty ──────────────────

  test("AC-3: stops loop early when runPrecheck returns no flaggedStories before max attempts", async () => {
    let callCount = 0;
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount === 1) return makeBlockedPrecheck(["US-001"]);
      return makePassingPrecheck(); // Clears on second check
    }) as never;

    await runReplanLoop(tmpDir, makeConfig("block", 5), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    // Should stop after clearing — not run all 5 attempts
    expect(_planDeps.runPrecheck).toHaveBeenCalledTimes(2);
    expect(_planDeps.processExit).not.toHaveBeenCalled();
  });

  test("AC-3: resolves without error when loop exits early", async () => {
    let callCount = 0;
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount === 1) return makeBlockedPrecheck(["US-001"]);
      return makePassingPrecheck();
    }) as never;

    await expect(
      runReplanLoop(tmpDir, makeConfig("block"), {
        feature: "test-feature",
        prd,
        prdPath,
      }),
    ).resolves.toBeUndefined();
  });

  // ── AC-4: respects maxReplanAttempts ─────────────────────────────────────

  test("AC-4: calls planDecompose exactly maxReplanAttempts times when always blocked (custom: 2)", async () => {
    _planDeps.runPrecheck = mock(async () => makeBlockedPrecheck(["US-001"])) as never;

    await expect(
      runReplanLoop(tmpDir, makeConfig("block", 2), {
        feature: "test-feature",
        prd,
        prdPath,
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(_planDeps.planDecompose).toHaveBeenCalledTimes(2);
  });

  test("AC-4: uses default maxReplanAttempts of 3 when not set in config", async () => {
    const configNoAttempts = {
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 10,
          maxDescriptionLength: 3000,
          maxBulletPoints: 12,
          action: "block",
          // maxReplanAttempts intentionally omitted — must default to 3
        },
      },
    } as unknown as NaxConfig;

    _planDeps.runPrecheck = mock(async () => makeBlockedPrecheck(["US-001"])) as never;

    await expect(
      runReplanLoop(tmpDir, configNoAttempts, {
        feature: "test-feature",
        prd,
        prdPath,
      }),
    ).rejects.toThrow("process.exit(1)");

    // 3 default attempts = 3 decompose calls
    expect(_planDeps.planDecompose).toHaveBeenCalledTimes(3);
  });

  // ── AC-5: exits with code 1 after max attempts exhausted ─────────────────

  test("AC-5: calls processExit(1) when max attempts exhausted and stories still blocked", async () => {
    _planDeps.runPrecheck = mock(async () => makeBlockedPrecheck(["US-001"])) as never;

    await expect(
      runReplanLoop(tmpDir, makeConfig("block", 1), {
        feature: "test-feature",
        prd,
        prdPath,
      }),
    ).rejects.toThrow();

    expect(_planDeps.processExit).toHaveBeenCalledWith(1);
  });

  test("AC-5: does not call processExit when loop resolves successfully", async () => {
    let callCount = 0;
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount === 1) return makeBlockedPrecheck(["US-001"]);
      return makePassingPrecheck();
    }) as never;

    await runReplanLoop(tmpDir, makeConfig("block"), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    expect(_planDeps.processExit).not.toHaveBeenCalled();
  });

  // ── AC-7: progress log emitted before each attempt ───────────────────────
  // The implementation should log: [Replan N/M] Decomposing K oversized stories...
  // Structural verification: decompose is called once per story per attempt

  test("AC-7: calls planDecompose for each flagged story on every replan attempt", async () => {
    let callCount = 0;
    // Two consecutive blocked attempts before clearing
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount <= 2) return makeBlockedPrecheck(["US-001"]);
      return makePassingPrecheck();
    }) as never;

    await runReplanLoop(tmpDir, makeConfig("block", 5), {
      feature: "test-feature",
      prd,
      prdPath,
    });

    // 2 attempts × 1 story each = 2 decompose calls
    expect(_planDeps.planDecompose).toHaveBeenCalledTimes(2);
  });

  test("AC-7: multiple flagged stories are each decomposed on every attempt", async () => {
    const prd3 = makePrd(["US-001", "US-002", "US-003"]);
    let callCount = 0;
    _planDeps.runPrecheck = mock(async () => {
      callCount++;
      if (callCount === 1) return makeBlockedPrecheck(["US-001", "US-002", "US-003"]);
      return makePassingPrecheck();
    }) as never;
    _planDeps.readFile = mock(async () => JSON.stringify(prd3)) as never;

    await runReplanLoop(tmpDir, makeConfig("block"), {
      feature: "test-feature",
      prd: prd3,
      prdPath,
    });

    // 1 attempt × 3 stories = 3 decompose calls
    expect(_planDeps.planDecompose).toHaveBeenCalledTimes(3);
  });
});
