/**
 * Tests for US-004: skipped packages reach status.json.
 *
 * Acceptance criteria:
 * 1. When the acceptance stage fails because targets are missing, then
 *    `AcceptanceLoopResult` carries the list of missing-target packages.
 * 2. Given an acceptance stage stub that fails with one missing package, when
 *    the completion phase runs, then `setPostRunPhase("acceptance", ...)`
 *    receives `status: "failed"` and `skippedPackages` containing that package.
 * 3. When acceptance fails because a target is missing, then
 *    `setPostRunPhase("acceptance", ...)` is never called with `status: "passed"`.
 * 4. When acceptance passes with every target present, then the recorded
 *    acceptance status is `"passed"` and has no `skippedPackages`.
 * 5. Given a resumed run whose status has acceptance `status: "failed"` and a
 *    non-empty `skippedPackages`, when completion evaluates post-run phases,
 *    then it reruns acceptance rather than skipping it.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "@/config";
import { type RunnerCompletionOptions, _runnerCompletionDeps, runCompletionPhase } from "@/execution";
import { StatusWriter } from "@/execution";
import { type AcceptanceLoopContext, _runAcceptanceTestsOnceDeps, runAcceptanceLoop } from "@/execution/lifecycle";
import type { AcceptanceLoopResult } from "@/execution/lifecycle";
import { _runCompletionDeps } from "@/execution/lifecycle";
import type { DeferredRegressionResult } from "@/execution/lifecycle/run-regression";
import type { PostRunStatus } from "@/execution/status-file";
import type { LoadedHooksConfig } from "@/hooks";
import { pipelineEventBus } from "@/pipeline";
import type { PRD, UserStory } from "@/prd";
import {
  cleanupTempDir,
  makeDispatchContext,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makeStatusWriter,
  makeStory,
  makeTempDir,
} from "@test/helpers";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePrd(): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    userStories: [
      {
        id: "US-004-1",
        title: "Test story",
        description: "A test story",
        acceptanceCriteria: ["AC1"],
        dependencies: [],
        tags: [],
        status: "passed" as const,
        passes: true,
        escalations: [],
        attempts: 0,
      },
    ],
  };
}

function makeAcceptanceCtx(): AcceptanceLoopContext {
  const config = makeNaxConfig({ acceptance: { maxRetries: 3 } });
  const runtime = makeMockRuntime({ config });
  return {
    config,
    prd: makePrd(),
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/workdir",
    feature: "test-feature",
    hooks: {} as AcceptanceLoopContext["hooks"],
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 1,
    allStoryMetrics: [],
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    agentManager: makeMockAgentManager(),
    sessionManager: runtime.sessionManager,
    runtime,
    abortSignal: new AbortController().signal,
  };
}

function makePRD(stories: Array<{ id: string; status: UserStory["status"] }>): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    userStories: stories.map(({ id, status }) =>
      makeStory({
        id,
        title: `Story ${id}`,
        status,
        passes: status === "passed",
        acceptanceCriteria: ["AC-1"],
        attempts: 1,
      }),
    ),
  };
}

function makeTestConfig(): NaxConfig {
  return makeNaxConfig({
    acceptance: { enabled: true, maxRetries: 3 },
    execution: { regressionGate: { mode: "disabled" } },
    quality: { commands: { test: "bun test" } },
  });
}

function makePostRunStatus(
  acceptanceStatus: PostRunStatus["acceptance"]["status"],
  regressionStatus: PostRunStatus["regression"]["status"],
  acceptanceSkippedPackages?: string[],
): PostRunStatus {
  const acceptance: PostRunStatus["acceptance"] = { status: acceptanceStatus };
  if (acceptanceSkippedPackages) {
    acceptance.skippedPackages = acceptanceSkippedPackages;
  }
  return {
    acceptance,
    regression: { status: regressionStatus },
  };
}

function makeWriter(postRunStatus: PostRunStatus = makePostRunStatus("not-run", "not-run")) {
  return makeStatusWriter({ getPostRunStatus: mock(() => postRunStatus) });
}

const WORKDIR = `/tmp/nax-us-004-${randomUUID()}`;

function makeOpts(config: NaxConfig, prd: PRD, statusWriter: StatusWriter): RunnerCompletionOptions {
  const runtime = Object.assign(makeMockRuntime(), {
    outputDir: `${WORKDIR}/output`,
    close: async () => {},
    costAggregator: {
      snapshot: () => ({
        totalCostUsd: 0,
        totalEstimatedCostUsd: 0,
        totalExactCostUsd: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        callCount: 0,
        errorCount: 0,
      }),
      byStage: () => ({}),
      byStory: () => ({}),
      byAgent: () => ({}),
      byCall: () => ({}),
      byScope: () => ({}),
      openScope: () => ({
        scopeId: "test-scope",
        snapshot: () => ({
          totalCostUsd: 0,
          totalEstimatedCostUsd: 0,
          totalExactCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
        }),
        close: () => {},
      }),
      record: () => {},
      recordError: () => {},
      recordOperationSummary: () => {},
      drain: async () => {},
    },
  });
  return {
    config,
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "test-feature",
    workdir: WORKDIR,
    statusFile: `${WORKDIR}/status.json`,
    logFilePath: undefined,
    runId: "run-001",
    startedAt: new Date(0).toISOString(),
    startTime: Date.now() - 1000,
    formatterMode: "quiet",
    headless: false,
    prd,
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter: statusWriter,
    pluginRegistry: makePluginRegistry(),
    prdPath: `${WORKDIR}/prd.json`,
    ...makeDispatchContext({ runtime }),
  };
}

const defaultAcceptanceResult: AcceptanceLoopResult = {
  success: true,
  prd: makePRD([{ id: "US-001", status: "passed" }]),
  totalCost: 0,
  iterations: 1,
  storiesCompleted: 1,
  prdDirty: false,
};

const defaultRegressionResult: DeferredRegressionResult = {
  success: true,
  failedTests: 0,
  failedTestFiles: [],
  passedTests: 5,
  rectificationAttempts: 0,
  affectedStories: [],
};

const origRunnerDeps = { ..._runnerCompletionDeps };
const origRunDeps = { ..._runCompletionDeps };

beforeEach(() => {
  _runnerCompletionDeps.runAcceptanceLoop = mock(async (): Promise<AcceptanceLoopResult> => defaultAcceptanceResult);
  _runCompletionDeps.runDeferredRegression = mock(
    async (): Promise<DeferredRegressionResult> => defaultRegressionResult,
  );
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origRunnerDeps);
  Object.assign(_runCompletionDeps, origRunDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ─── AC-1: AcceptanceLoopResult carries skippedPackages on missing-target failure ──

describe("US-004 AC-1: runAcceptanceLoop propagates skippedPackages on missing-target failure", () => {
  let origImportAcceptanceStage: typeof _runAcceptanceTestsOnceDeps.importAcceptanceStage;

  beforeEach(() => {
    origImportAcceptanceStage = _runAcceptanceTestsOnceDeps.importAcceptanceStage;
  });

  afterEach(() => {
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = origImportAcceptanceStage;
  });

  test("propagates skippedPackages from acceptanceFailures.missingTargets to AcceptanceLoopResult", async () => {
    // The real acceptance stage puts missing targets on ctx.acceptanceFailures.missingTargets.
    // The loop must surface that on the returned AcceptanceLoopResult.skippedPackages.
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = async () =>
      ({
        acceptanceStage: {
          execute: (ctx: {
            acceptanceFailures?: {
              failedACs: string[];
              findings: unknown[];
              testOutput: string;
              failedPackages?: unknown[];
              missingTargets?: string[];
            };
          }) => {
            ctx.acceptanceFailures = {
              failedACs: [],
              findings: [],
              testOutput: "",
              failedPackages: [],
              missingTargets: ["/tmp/workdir/pkg-a", "/tmp/workdir/pkg-b"],
            };
            return Promise.resolve({ action: "fail" as const, reason: "missing" });
          },
        },
      }) as never;

    const ctx = makeAcceptanceCtx();
    ctx.featureDir = undefined;
    ctx.acceptanceTestPaths = [{ testPath: "/tmp/test.ts", packageDir: "/tmp/workdir" }];
    // Disable fix cycles by giving the loop a context that returns continue/fail without
    // trying to run fix logic. Use a low maxRetries so the first fail returns immediately.
    ctx.config = makeNaxConfig({ acceptance: { maxRetries: 1 } });

    const result = await runAcceptanceLoop(ctx);

    expect(result.success).toBe(false);
    expect(result.skippedPackages).toEqual(["/tmp/workdir/pkg-a", "/tmp/workdir/pkg-b"]);
  });

  test("propagates skippedPackages from the action result when the stage returns it directly", async () => {
    // The action-level skippedPackages field is the source-of-truth when the
    // acceptance stage itself reports which packages it skipped (or in the
    // test scenario where a stub returns it on the action).
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = async () =>
      ({
        acceptanceStage: {
          execute: (_ctx: unknown) =>
            Promise.resolve({
              action: "fail" as const,
              reason: "missing",
              skippedPackages: ["pkg-a"],
            }),
        },
      }) as never;

    const ctx = makeAcceptanceCtx();
    ctx.featureDir = undefined;
    ctx.config = makeNaxConfig({ acceptance: { maxRetries: 1 } });

    const result = await runAcceptanceLoop(ctx);

    expect(result.success).toBe(false);
    expect(result.skippedPackages).toEqual(["pkg-a"]);
  });
});

// ─── AC-2: setPostRunPhase receives status=failed and skippedPackages on a missing-package failure ──

describe("US-004 AC-2: completion phase reports status=failed and skippedPackages on a missing-package failure", () => {
  test("setPostRunPhase('acceptance', ...) receives status='failed' and skippedPackages=['pkg-a']", async () => {
    const statusWriter = makeWriter(makePostRunStatus("not-run", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeTestConfig();

    _runnerCompletionDeps.runAcceptanceLoop = mock(
      async (): Promise<AcceptanceLoopResult> => ({
        success: false,
        prd,
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 1,
        prdDirty: false,
        failedACs: [],
        skippedPackages: ["pkg-a"],
      }),
    ) as typeof _runnerCompletionDeps.runAcceptanceLoop;

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const acceptanceCalls = statusWriter.setPostRunPhase.mock.calls.filter((c: unknown[]) => c[0] === "acceptance");
    const failedCall = acceptanceCalls.find((c: unknown[]) => (c[1] as { status?: string })?.status === "failed");
    expect(failedCall).toBeDefined();
    expect((failedCall?.[1] as { skippedPackages?: string[] } | undefined)?.skippedPackages).toEqual(["pkg-a"]);
  });
});

// ─── AC-3: A missing-target failure is never reported as 'passed' ──

describe("US-004 AC-3: missing-target acceptance failure is never reported as 'passed'", () => {
  test("setPostRunPhase is never called with status='passed' when acceptance fails with missing packages", async () => {
    const statusWriter = makeWriter(makePostRunStatus("not-run", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeTestConfig();

    _runnerCompletionDeps.runAcceptanceLoop = mock(
      async (): Promise<AcceptanceLoopResult> => ({
        success: false,
        prd,
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 1,
        prdDirty: false,
        failedACs: [],
        skippedPackages: ["pkg-a"],
      }),
    ) as typeof _runnerCompletionDeps.runAcceptanceLoop;

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const acceptanceCalls = statusWriter.setPostRunPhase.mock.calls.filter((c: unknown[]) => c[0] === "acceptance");
    const passedCall = acceptanceCalls.find((c: unknown[]) => (c[1] as { status?: string })?.status === "passed");
    expect(passedCall).toBeUndefined();
  });
});

// ─── AC-4: passing acceptance has status='passed' and no skippedPackages ──

describe("US-004 AC-4: passing acceptance has status='passed' and no skippedPackages", () => {
  test("setPostRunPhase receives status='passed' and skippedPackages is empty/undefined on full pass", async () => {
    const statusWriter = makeWriter(makePostRunStatus("not-run", "not-run"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeTestConfig();

    _runnerCompletionDeps.runAcceptanceLoop = mock(
      async (): Promise<AcceptanceLoopResult> => ({
        success: true,
        prd,
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 1,
        prdDirty: false,
      }),
    ) as typeof _runnerCompletionDeps.runAcceptanceLoop;

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    const acceptanceCalls = statusWriter.setPostRunPhase.mock.calls.filter((c: unknown[]) => c[0] === "acceptance");
    const passedCall = acceptanceCalls.find((c: unknown[]) => (c[1] as { status?: string })?.status === "passed");
    expect(passedCall).toBeDefined();
    const skipped = (passedCall?.[1] as { skippedPackages?: string[] } | undefined)?.skippedPackages;
    expect(skipped === undefined || (Array.isArray(skipped) && skipped.length === 0)).toBe(true);
  });

  test("passing run clears stale skippedPackages left from a prior failed run (AC-4 merge)", async () => {
    // AC-4 contract: when the new run passes, the recorded acceptance must
    // have status="passed" AND no skippedPackages — even if a prior run
    // recorded skippedPackages on a failed status. StatusWriter merges
    // updates shallowly, so the runner-completion must explicitly clear
    // the field when transitioning to "passed".
    const tmpDir = makeTempDir("nax-us-004-ac4-merge-");
    const statusFile = `${tmpDir}/status.json`;
    const realStatusWriter = new StatusWriter(statusFile, makeNaxConfig(), {
      runId: "run-merge",
      feature: "test-feature",
      startedAt: new Date(0).toISOString(),
      dryRun: false,
      startTimeMs: Date.now(),
      pid: process.pid,
    });
    try {
      // Seed the prior failed state.
      realStatusWriter.setPostRunPhase("acceptance", {
        status: "failed",
        failedACs: [],
        retries: 1,
        lastRunAt: new Date(0).toISOString(),
        skippedPackages: ["pkg-a"],
      });
      const seeded = realStatusWriter.getPostRunStatus();
      expect(seeded.acceptance.skippedPackages).toEqual(["pkg-a"]);

      const prd = makePRD([{ id: "US-001", status: "passed" }]);
      const config = makeTestConfig();
      _runnerCompletionDeps.runAcceptanceLoop = mock(
        async (): Promise<AcceptanceLoopResult> => ({
          success: true,
          prd,
          totalCost: 0,
          iterations: 1,
          storiesCompleted: 1,
          prdDirty: false,
        }),
      ) as typeof _runnerCompletionDeps.runAcceptanceLoop;

      await runCompletionPhase(makeOpts(config, prd, realStatusWriter));

      const final = realStatusWriter.getPostRunStatus();
      expect(final.acceptance.status).toBe("passed");
      expect(final.acceptance.skippedPackages).toBeUndefined();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});

// ─── AC-5: a failed status with non-empty skippedPackages re-runs the acceptance loop ──

describe("US-004 AC-5: a failed status with non-empty skippedPackages re-runs the acceptance loop", () => {
  test("calls runAcceptanceLoop and forwards skippedPackages when resumed with status=failed and skippedPackages=['pkg-a']", async () => {
    const statusWriter = makeWriter(makePostRunStatus("failed", "not-run", ["pkg-a"]));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeTestConfig();

    let receivedSkippedPackages: unknown;
    let loopWasCalled = false;
    _runnerCompletionDeps.runAcceptanceLoop = mock(
      async (ctx: AcceptanceLoopContext & { skippedPackages?: string[] }): Promise<AcceptanceLoopResult> => {
        loopWasCalled = true;
        receivedSkippedPackages = ctx.skippedPackages;
        return {
          success: true,
          prd: ctx.prd,
          totalCost: 0,
          iterations: 1,
          storiesCompleted: 1,
          prdDirty: false,
        };
      },
    ) as typeof _runnerCompletionDeps.runAcceptanceLoop;

    await runCompletionPhase(makeOpts(config, prd, statusWriter));

    expect(loopWasCalled).toBe(true);
    expect(receivedSkippedPackages).toEqual(["pkg-a"]);
  });
});
