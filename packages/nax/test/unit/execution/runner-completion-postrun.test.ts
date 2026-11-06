/**
 * runCompletionPhase — parallel-mode forwarding into handleRunCompletion.
 *
 * The acceptance-phase instrumentation these tests used to cover (setPostRunPhase
 * at each acceptance entry/exit boundary) was deleted with the completion
 * acceptance loop in pipeline-post-run-delete US-006; the completion phase has no
 * acceptance phase left to instrument. What remains here is the isSequential
 * forwarding, which is unrelated to acceptance.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { makeMockRuntime, makeNaxConfig, makePluginRegistry, makeStatusWriter } from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { RunCompletionResult } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD, UserStory } from "@/prd";

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
      regressionGate: { mode: "disabled" },
    },
  });
}

const WORKDIR = `/tmp/nax-test-runner-completion-postrun-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  statusWriter: ReturnType<typeof makeStatusWriter>,
): RunnerCompletionOptions {
  const runtime = makeMockRuntime();
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

// Default mock for handleRunCompletion (no regression)
const defaultCompletionResult: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  reportedTotal: 0,
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
  pluginGateFailed: false,
};

const origDeps = { ..._runnerCompletionDeps };

beforeEach(() => {
  _runnerCompletionDeps.handleRunCompletion = mock(async () => defaultCompletionResult);
  _runnerCompletionDeps.loadConfigForPackage = mock(async () => makeConfig(true));
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// isSequential forwarding: RunnerOptions.parallel -> handleRunCompletion
// ---------------------------------------------------------------------------

describe("runCompletionPhase - forwards parallel mode as isSequential", () => {
  // Completion is sequential regardless of a hand-built parallel option.
  test.each([
    [undefined, true],
    [0, true],
    [1, true],
    [Number.NaN, true],
    [4, true],
  ] as const)("parallel=%s -> isSequential=%s", async (parallel, expectedIsSequential) => {
    let captured: { isSequential?: boolean } | undefined;
    _runnerCompletionDeps.handleRunCompletion = mock(async (opts) => {
      captured = opts as { isSequential?: boolean };
      return defaultCompletionResult;
    });

    const config = makeConfig(false);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const statusWriter = makeStatusWriter();
    const opts: RunnerCompletionOptions = {
      ...makeOpts(config, prd, statusWriter),
      ...(parallel === undefined ? {} : { parallel }),
    };

    await runCompletionPhase(opts);

    expect(captured?.isSequential).toBe(expectedIsSequential);
  });

  test("workflow mode clamps --parallel 4 to sequential", async () => {
    let captured: { isSequential?: boolean } | undefined;
    _runnerCompletionDeps.handleRunCompletion = mock(async (opts) => {
      captured = opts as { isSequential?: boolean };
      return defaultCompletionResult;
    });

    const base = makeConfig(false);
    const config = { ...base, execution: { ...base.execution, mode: "workflow" as const } };
    const opts: RunnerCompletionOptions = {
      ...makeOpts(config, makePRD([{ id: "US-001", status: "passed" }]), makeStatusWriter()),
      parallel: 4,
    };

    await runCompletionPhase(opts);

    expect(captured?.isSequential).toBe(true);
  });
});
