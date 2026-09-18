/**
 * runner-completion.ts — carry the reconciled run total out of the completion
 * phase (US-001).
 *
 * The completion phase already destructures `reportedTotal` from its inner
 * `handleRunCompletion` result and uses it locally (status.json, headless
 * footer, exit summary) — but the field was dropped from the value
 * `runCompletionPhase` returns, so the runner never received it. These tests
 * pin the seam: the `RunnerCompletionResult` that `runCompletionPhase`
 * produces carries the same cost-aggregator-reconciled total the inner
 * completion computed.
 *
 * AC1: totalCostUsd 5.6995 + totalErrorCostUsd 0.1047 → reportedTotal 5.8042
 * AC2: totalCostUsd 5.6995 + totalErrorCostUsd 0     → reportedTotal 5.6995
 * AC8: empty snapshot                                → reportedTotal 0
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeSpawn,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { RunCompletionResult } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD } from "@/prd";
import { totalSpendUsd } from "@/runtime";
import type { CostSnapshot } from "@/runtime/cost-aggregator";
import { _gitDeps } from "@/utils/git";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCompletePrd(): PRD {
  return makePRD({
    userStories: [makeStory({ id: "US-001", status: "passed", passes: true })],
  });
}

function emptySnapshot(): CostSnapshot {
  return {
    totalCostUsd: 0,
    totalEstimatedCostUsd: 0,
    totalExactCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    callCount: 0,
    errorCount: 0,
    totalErrorCostUsd: 0,
  };
}

const WORKDIR = `/tmp/nax-test-runner-completion-total-${randomUUID()}`;

function makeOpts(): RunnerCompletionOptions {
  const runtime = makeMockRuntime();
  const config: NaxConfig = makeNaxConfig({
    acceptance: { enabled: false },
    execution: { regressionGate: { mode: "disabled" } },
  });
  return {
    config,
    hooks: { hooks: {}, _skipGlobal: false },
    feature: "test-feature",
    workdir: WORKDIR,
    statusFile: `${WORKDIR}/status.json`,
    logFilePath: undefined,
    runId: "run-001",
    startedAt: new Date().toISOString(),
    startTime: Date.now() - 1000,
    formatterMode: "quiet",
    headless: false,
    prd: makeCompletePrd(),
    allStoryMetrics: [],
    totalCost: 5.6995,
    storiesCompleted: 1,
    iterations: 1,
    statusWriter: makeStatusWriter(),
    pluginRegistry: makePluginRegistry(),
    prdPath: `${WORKDIR}/prd.json`,
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
  };
}

/** Base handleRunCompletion result — reportedTotal is overridden per test. */
const baseCompletionResult: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  reportedTotal: 0,
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
  pluginGateFailed: false,
};

const origDeps = { ..._runnerCompletionDeps };
const origGitSpawn = _gitDeps.spawn;

beforeEach(() => {
  _runnerCompletionDeps.handleRunCompletion = mock(async () => baseCompletionResult);
  _runnerCompletionDeps.loadConfigForPackage = mock(async () =>
    makeNaxConfig({
      acceptance: { enabled: false },
      execution: { regressionGate: { mode: "disabled" } },
    }),
  );
  // Hermetic: the completion phase auto-commits any dirty nax runtime files at
  // run end via autoCommitIfDirty — stub the git process it would spawn.
  _gitDeps.spawn = makeSpawn().spawn;
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origDeps);
  _gitDeps.spawn = origGitSpawn;
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC1 / AC2 / AC8 — runCompletionPhase surfaces reportedTotal from the snapshot
// ---------------------------------------------------------------------------

describe("runCompletionPhase — US-001 reportedTotal seam", () => {
  test("AC1: reportedTotal reconciles failed-dispatch spend (5.6995 + 0.1047 = 5.8042)", async () => {
    // The cost-aggregator snapshot the inner completion saw.
    const aggSnap = { ...emptySnapshot(), totalCostUsd: 5.6995, totalErrorCostUsd: 0.1047 };
    // handleRunCompletion (the inner completion) reconciles the snapshot into
    // its result's reportedTotal via totalSpendUsd — what the runner must see.
    const reconciled = totalSpendUsd(aggSnap);
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({
      ...baseCompletionResult,
      reportedTotal: reconciled,
    }));

    const result = await runCompletionPhase(makeOpts());

    expect(result.reportedTotal).toBeCloseTo(5.8042, 4);
    expect(result.reportedTotal).toBe(reconciled);
  });

  test("AC2: reportedTotal carries totalCostUsd alone when nothing failed (5.6995 + 0 = 5.6995)", async () => {
    const aggSnap = { ...emptySnapshot(), totalCostUsd: 5.6995, totalErrorCostUsd: 0 };
    const reconciled = totalSpendUsd(aggSnap);
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({
      ...baseCompletionResult,
      reportedTotal: reconciled,
    }));

    const result = await runCompletionPhase(makeOpts());

    expect(result.reportedTotal).toBeCloseTo(5.6995, 4);
    expect(result.reportedTotal).toBe(reconciled);
  });

  test("AC8: empty snapshot leaves reportedTotal at 0 (no fallback invented)", async () => {
    // Empty cost-aggregator snapshot → reportedTotal 0, exactly the number
    // already written to status.json. No Math.max-style guard may paper over it.
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({
      ...baseCompletionResult,
      reportedTotal: totalSpendUsd(emptySnapshot()),
    }));

    const result = await runCompletionPhase(makeOpts());

    expect(result.reportedTotal).toBe(0);
  });

  test("the other completion-result fields are unaffected by the new reportedTotal field", async () => {
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({
      ...baseCompletionResult,
      reportedTotal: 5.8042,
    }));

    const result = await runCompletionPhase(makeOpts());

    expect(result.durationMs).toBe(100);
    expect(result.acceptancePassed).toBe(true);
    expect(result.pluginGateFailed).toBe(false);
    expect(typeof result.runCompletedAt).toBe("string");
  });
});
