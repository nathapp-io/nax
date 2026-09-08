/**
 * Dry-run lifecycle gates — nax#1809.
 *
 * `--dry-run` is documented as "Show plan without executing". #1808 stopped
 * the PRD persistence and auto-commit, but three lifecycle boundaries still
 * performed real work or wrote tracked files under a dry run:
 *
 *   1. the pre-run acceptance pipeline dispatched generate/refine agents and
 *      wrote `.nax-acceptance.test.ts`, `acceptance-refined.json` and
 *      `acceptance-meta.json` (all tracked for many features);
 *   2. the completion phase ran the real acceptance suite (test-process spawn)
 *      plus acceptance-source-fix / acceptance-test-fix agents, and, when
 *      `finish.enabled`, the finish phase pushed a branch and opened a PR;
 *   3. `preIterationTierCheck` could persist escalation state (savePRD) for a
 *      partially-attempted pending story.
 *
 * These tests pin the invariant: under a dry run, nothing dispatches an agent,
 * spawns a test run, or persists run state — status.json updates excepted
 * (deliberate, #1808).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import { stopHeartbeat } from "@/execution/crash-recovery";
import { _runnerCompletionDeps } from "@/execution/runner-completion";
import { executeUnified, type SequentialExecutionContext } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD, UserStory } from "@/prd/types";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

afterEach(() => {
  stopHeartbeat();
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate 1 — pre-run acceptance pipeline never dispatches under a dry run
// ─────────────────────────────────────────────────────────────────────────────

describe("executeUnified — pre-run acceptance pipeline under dry run (nax#1809)", () => {
  let tempDir: string;
  let prdPath: string;
  let story: UserStory;
  let prd: PRD;

  beforeEach(() => {
    tempDir = makeTempDir();
    prdPath = join(tempDir, "prd.json");
    story = makeStory({
      id: "US-001",
      status: "pending",
      passes: false,
      acceptanceCriteria: ["AC-1: it works"],
    });
    prd = makePRD({ userStories: [story] });
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function makeDryRunCtx(): SequentialExecutionContext {
    return {
      prdPath,
      workdir: tempDir,
      featureDir: tempDir,
      config: makeNaxConfig({
        execution: { maxIterations: 10, costLimit: 100, iterationDelayMs: 0 },
      }),
      hooks: EMPTY_HOOKS,
      feature: "test-feature",
      dryRun: true,
      useBatch: false,
      pluginRegistry: makePluginRegistry(),
      statusWriter: makeStatusWriter(),
      runId: "run-test",
      startTime: Date.now(),
      batchPlan: [],
      interactionChain: null,
      parallelCount: 0,
      ...makeDispatchContext({ runtime: makeMockRuntime({ workdir: tempDir, dryRun: true }) }),
    };
  }

  function acceptanceArtifacts(): Array<{ name: string; path: string }> {
    return [
      { name: ".nax-acceptance.test.ts", path: join(tempDir, ".nax-acceptance.test.ts") },
      { name: "acceptance-refined.json", path: join(tempDir, "acceptance-refined.json") },
      { name: "acceptance-meta.json", path: join(tempDir, "acceptance-meta.json") },
    ];
  }

  test("completes without dispatching acceptance generation (refine/generate ops)", async () => {
    const { _acceptanceSetupDeps } = await import("@/pipeline/stages/acceptance-setup");
    const originalCallOp = _acceptanceSetupDeps.callOp;
    const callOpSpy = spyOn(_acceptanceSetupDeps, "callOp").mockImplementation(originalCallOp);
    try {
      const result = await executeUnified(makeDryRunCtx(), prd);

      expect(result.exitReason).toBe("completed");
      expect(callOpSpy).not.toHaveBeenCalled();
    } finally {
      callOpSpy.mockRestore();
    }
  });

  test("writes no acceptance artifacts (skeleton, refined, meta)", async () => {
    const result = await executeUnified(makeDryRunCtx(), prd);

    expect(result.exitReason).toBe("completed");
    for (const artifact of acceptanceArtifacts()) {
      expect(existsSync(artifact.path), artifact.name).toBe(false);
    }
  });

  test("leaves the PRD on disk untouched", async () => {
    const before = readFileSync(prdPath, "utf8");

    await executeUnified(makeDryRunCtx(), prd);

    expect(readFileSync(prdPath, "utf8")).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gate 4 — completion phase skips acceptance and finish under a dry run
// ─────────────────────────────────────────────────────────────────────────────

describe("runCompletionPhase — dry run skips acceptance and finish (nax#1809)", () => {
  let tempDir: string;
  let prdPath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    prdPath = join(tempDir, "prd.json");
    const completedStory = makeStory({ id: "US-001", status: "passed", passes: true });
    const prd = makePRD({ userStories: [completedStory] });
    writeFileSync(prdPath, JSON.stringify(prd, null, 2));
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // The acceptance loop is the test subject here. The finish phase is *called*
  // by the completion phase but self-gates on runtime.dryRun from inside
  // finishSkipReason — its machine/push/status-write side effects are asserted
  // in test/unit/finish/phase.test.ts.
  test("does not dispatch the acceptance loop, the finish machine, or the regression gate", async () => {
    const { runCompletionPhase } = await import("@/execution/runner-completion");
    const { _runCompletionDeps, handleRunCompletion } = await import("@/execution/lifecycle/run-completion");
    const { _finishPhaseDeps } = await import("@/finish");

    const acceptanceSpy = spyOn(_runnerCompletionDeps, "runAcceptanceLoop").mockImplementation(async () => {
      throw new Error("acceptance loop dispatched under a dry run");
    });
    const finishMachineSpy = spyOn(_finishPhaseDeps, "runFinishMachine").mockImplementation(async () => {
      throw new Error("finish machine ran under a dry run");
    });
    // nax#1809: the deferred/per-story regression gate would spawn the real
    // project suite under a dry run — it must stay uninvoked (and uncovered by
    // the Gate-1-4 spies above because it dispatches inside the REAL
    // handleRunCompletion this test wraps).
    const regressionSpy = spyOn(_runCompletionDeps, "runDeferredRegression").mockImplementation(async () => {
      throw new Error("regression gate dispatched under a dry run");
    });
    const completionSpy = spyOn(_runnerCompletionDeps, "handleRunCompletion").mockImplementation(async (opts) => {
      await handleRunCompletion(opts);
      return {
        durationMs: 0,
        runCompletedAt: new Date().toISOString(),
        reportedTotal: 0,
        finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
        pluginGateFailed: false,
      };
    });

    try {
      const prd = makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] });
      const config = makeNaxConfig({
        execution: {
          maxIterations: 1,
          costLimit: 100,
          iterationDelayMs: 0,
          // Per-story mode + a real test command is the default nax-setup'd repo:
          // without the dry-run gate the regression branch would spawn the suite.
          regressionGate: { enabled: true, mode: "per-story", timeoutSeconds: 30, acceptOnTimeout: true },
        },
        quality: { commands: { test: "bun test" } },
      });

      const completionOpts: Parameters<typeof runCompletionPhase>[0] = {
        config,
        hooks: EMPTY_HOOKS,
        feature: "test-feature",
        workdir: tempDir,
        statusFile: join(tempDir, "status.json"),
        logFilePath: join(tempDir, "run.log"),
        runId: "run-test",
        startedAt: "2026-01-01T00:00:00.000Z",
        startTime: 0,
        formatterMode: "quiet" as const,
        headless: true,
        featureDir: tempDir,
        prd,
        allStoryMetrics: [],
        totalCost: 0,
        storiesCompleted: 1,
        iterations: 1,
        statusWriter: makeStatusWriter(),
        pluginRegistry: makePluginRegistry(),
        prdPath,
        exitReason: "completed",
        ...makeDispatchContext({
          runtime: makeMockRuntime({ workdir: tempDir, dryRun: true }),
        }),
      };
      const result = await runCompletionPhase(completionOpts);

      expect(acceptanceSpy).not.toHaveBeenCalled();
      expect(finishMachineSpy).not.toHaveBeenCalled();
      expect(regressionSpy).not.toHaveBeenCalled();
      expect(result.acceptancePassed).toBe(true);
    } finally {
      acceptanceSpy.mockRestore();
      finishMachineSpy.mockRestore();
      regressionSpy.mockRestore();
      completionSpy.mockRestore();
    }
  });
});
