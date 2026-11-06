/**
 * runCompletionPhase — run-status classification and dry-run/index-sweep behaviour.
 *
 * The rerun-skip tests these used to carry (AC1–AC4, plus the "skip only applies
 * when acceptance/regression config is active" guard) exercised the completion
 * phase's post-run status block, which pipeline-post-run-delete US-006 removed
 * along with the acceptance loop. What remains here does not involve acceptance.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type MockStatusWriter,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makeSpawn,
  makeStatusWriter,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import { _runCompletionDeps } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import type { PostRunStatus } from "@/execution/status-file";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD, UserStory } from "@/prd";
import { _gitDeps } from "@/utils/git";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 1,
  };
}

function makePRD(stories: Array<{ id: string; status: UserStory["status"] }>): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories.map(({ id, status }) => makeStory(id, status)),
  };
}

function makeConfig(acceptanceEnabled = true): NaxConfig {
  return makeNaxConfig({
    acceptance: {
      enabled: acceptanceEnabled,
      maxRetries: 3,
    },
    execution: {
      mode: "pipeline",
      regressionGate: {
        enabled: true,
        mode: "deferred",
        timeoutSeconds: 30,
        acceptOnTimeout: true,
      },
    },
    quality: {
      commands: {
        test: "bun test",
      },
    },
  });
}

function makePostRunStatus(
  acceptanceStatus: PostRunStatus["acceptance"]["status"],
  regressionStatus: PostRunStatus["regression"]["status"],
): PostRunStatus {
  return {
    acceptance: { status: acceptanceStatus },
    regression: { status: regressionStatus },
  };
}

function makeWriter(postRunStatus: PostRunStatus = makePostRunStatus("not-run", "not-run")) {
  return makeStatusWriter({ getPostRunStatus: mock(() => postRunStatus) });
}

const WORKDIR = `/tmp/nax-test-rerun-skip-${randomUUID()}`;

function makeOpts(config: NaxConfig, prd: PRD, statusWriter: MockStatusWriter): RunnerCompletionOptions {
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
    startedAt: new Date().toISOString(),
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
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
  };
}

const origRunnerDeps = { ..._runnerCompletionDeps };
const origRunDeps = { ..._runCompletionDeps };

beforeEach(() => {
  _runnerCompletionDeps.runWorkflowFeature = mock(async () => null);
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origRunnerDeps);
  Object.assign(_runCompletionDeps, origRunDeps);
  pipelineEventBus.clear();
  mock.restore();
});

describe("runCompletionPhase - cost-limit exitReason surfaces distinctly", () => {
  test("sets feature-level run status to cost-limit when exitReason is cost-limit, even with incomplete stories", async () => {
    const statusWriter = makeWriter(makePostRunStatus("passed", "passed"));
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "pending" },
    ]);
    const config = makeConfig(true);

    await runCompletionPhase({
      ...makeOpts(config, prd, statusWriter),
      featureDir: `${WORKDIR}/features/test-feature`,
      exitReason: "cost-limit",
    });

    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("cost-limit");
  });

  test("falls back to completed/failed classification when exitReason is not cost-limit", async () => {
    const statusWriter = makeWriter(makePostRunStatus("passed", "passed"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig(true);

    await runCompletionPhase({
      ...makeOpts(config, prd, statusWriter),
      featureDir: `${WORKDIR}/features/test-feature`,
      exitReason: "completed",
    });

    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("completed");
  });

  test("a gating plugin-reviewer failure is not masked by a cost-limit exitReason", async () => {
    const statusWriter = makeWriter(makePostRunStatus("passed", "passed"));
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeNaxConfig({
      acceptance: { enabled: true, maxRetries: 3 },
      execution: {
        regressionGate: { enabled: true, mode: "deferred", timeoutSeconds: 30, acceptOnTimeout: true },
      },
      quality: { commands: { test: "bun test" } },
      review: { pluginMode: "gating" },
    });

    await runCompletionPhase({
      ...makeOpts(config, prd, statusWriter),
      featureDir: `${WORKDIR}/features/test-feature`,
      exitReason: "cost-limit",
      deferredReview: {
        runStartRef: "abc123",
        changedFiles: [],
        reviewerResults: [{ name: "my-reviewer", passed: false, output: "findings" }],
        anyFailed: true,
      },
    });

    // The feature-level status write (SFC-002) is the last call and is authoritative for
    // `nax status` — it must reflect the gating failure, not the cost-limit exitReason.
    expect(statusWriter.setRunStatus).toHaveBeenLastCalledWith("failed");
  });
});

// ---------------------------------------------------------------------------
// nax#1808: the completion phase must not auto-commit during a dry run
// ---------------------------------------------------------------------------

describe("runCompletionPhase - dry run", () => {
  test("does not run git add or commit when the run is a dry run", async () => {
    const origSpawn = _gitDeps.spawn;
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push(cmd);
      if (cmd.includes("rev-parse")) return `${WORKDIR}\n`;
      if (cmd.includes("status")) return " M src/foo.ts\n";
      return "";
    }).spawn;
    try {
      const opts = makeOpts(
        makeConfig(true),
        makePRD([{ id: "US-001", status: "passed" }]),
        makeWriter(makePostRunStatus("passed", "passed")),
      );
      (opts.runtime as { dryRun: boolean }).dryRun = true;

      await runCompletionPhase(opts);

      expect(calls.some((c) => c.includes("add"))).toBe(false);
      expect(calls.some((c) => c.includes("commit"))).toBe(false);
    } finally {
      _gitDeps.spawn = origSpawn;
    }
  });

  // Negative control: without it the assertions above pass vacuously whenever
  // the completion phase never reaches its auto-commit at all.
  test("still commits when the run is not a dry run", async () => {
    const origSpawn = _gitDeps.spawn;
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push(cmd);
      if (cmd.includes("rev-parse")) return `${WORKDIR}\n`;
      if (cmd.includes("status")) return " M src/foo.ts\n";
      if (cmd.includes("--cached")) return { exitCode: 1 }; // staged
      return "";
    }).spawn;
    try {
      const opts = makeOpts(
        makeConfig(true),
        makePRD([{ id: "US-001", status: "passed" }]),
        makeWriter(makePostRunStatus("passed", "passed")),
      );
      (opts.runtime as { dryRun: boolean }).dryRun = false;

      await runCompletionPhase(opts);

      expect(calls.some((c) => c.includes("commit"))).toBe(true);
    } finally {
      _gitDeps.spawn = origSpawn;
    }
  });
});

// ---------------------------------------------------------------------------
// nax#2490: the hidden-index-flag sweep runs before the run-end auto-commit
// ---------------------------------------------------------------------------

describe("runCompletionPhase - .nax index flag sweep (#2490)", () => {
  test("lists .nax index flags before the auto-commit stages anything", async () => {
    const origSpawn = _gitDeps.spawn;
    const calls: string[][] = [];
    _gitDeps.spawn = makeSpawn(({ cmd }) => {
      calls.push(cmd);
      if (cmd.includes("rev-parse")) return `${WORKDIR}\n`;
      if (cmd.includes("status")) return " M .nax/status.json\n";
      return "";
    }).spawn;
    try {
      await runCompletionPhase(
        makeOpts(
          makeConfig(true),
          makePRD([{ id: "US-001", status: "passed" }]),
          makeWriter(makePostRunStatus("passed", "passed")),
        ),
      );

      const sweep = calls.findIndex((c) => c.includes("ls-files"));
      const stage = calls.findIndex((c) => c.includes("add"));
      expect(sweep).toBeGreaterThanOrEqual(0);
      expect(stage).toBeGreaterThan(sweep);
    } finally {
      _gitDeps.spawn = origSpawn;
    }
  });
});
