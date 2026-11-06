/**
 * runCompletionPhase — the completion phase runs no acceptance loop (US-006).
 *
 * Workflow mode sets `acceptance.enabled` to false on every loaded config
 * (`config/workflow-mode.ts`), so the completion phase's post-run status block
 * was dead code kept alive only by its own tests. US-006 removes it: no
 * `getPostRunStatus` read, no `setPostRunPhase("acceptance", …)`, no
 * `postrun:phase:started` for acceptance, and no `_runnerCompletionDeps`
 * acceptance member to assign.
 *
 * These three tests pin that removal from the outside — through
 * `runCompletionPhase`, with every other dependency hermetic and no acceptance
 * dependency available to stub. The config and PRD are the ones that used to
 * make the acceptance phase start (enabled, complete PRD, not a dry run), so a
 * regression that reintroduces the block would fail here rather than pass
 * silently.
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
import {
  _runnerCompletionDeps,
  type RunnerCompletionOptions,
  type RunnerCompletionResult,
  runCompletionPhase,
} from "@/execution/runner-completion";
import type { PostRunPhaseStartedEvent } from "@/pipeline/event-bus";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD } from "@/prd";
import { _gitDeps } from "@/utils/git";

const WORKDIR = `/tmp/nax-test-runner-completion-no-acceptance-${randomUUID()}`;

/** The config shape that used to start the completion acceptance phase. */
function makeAcceptanceEnabledConfig(): NaxConfig {
  return makeNaxConfig({
    acceptance: { enabled: true, maxRetries: 3 },
    execution: { mode: "pipeline", regressionGate: { mode: "disabled" } },
  });
}

/** A complete PRD — `isComplete(prd)` is the block's other precondition. */
function makeCompletePrd(): PRD {
  return makePRD({ userStories: [makeStory({ id: "US-001", status: "passed", passes: true })] });
}

function makeOpts(config: NaxConfig, prd: PRD, statusWriter: RunnerCompletionOptions["statusWriter"]) {
  // dryRun false: the block was only skipped for a dry run (nax#1809).
  const runtime = makeMockRuntime({ config, workdir: WORKDIR, dryRun: false });
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
    statusWriter,
    pluginRegistry: makePluginRegistry(),
    prdPath: `${WORKDIR}/prd.json`,
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
  } satisfies RunnerCompletionOptions;
}

interface ObservedCompletion {
  readonly setPostRunPhaseCalls: ReadonlyArray<{ phase: string; update: Record<string, unknown> }>;
  readonly postRunPhaseStarted: readonly PostRunPhaseStartedEvent[];
  readonly getPostRunStatusCalls: number;
  /** Final `statusWriter.update` calls — non-zero means the phase ran to its end. */
  readonly statusUpdates: number;
  readonly result: RunnerCompletionResult;
}

/**
 * Run the completion phase with acceptance enabled, a complete PRD and no
 * acceptance dependency assigned anywhere — recording every observation the
 * ACs assert on.
 */
async function observeCompletion(): Promise<ObservedCompletion> {
  const postRunPhaseStarted: PostRunPhaseStartedEvent[] = [];
  const unsubscribe = pipelineEventBus.on("postrun:phase:started", (event) => {
    postRunPhaseStarted.push(event);
  });
  // Canary: a live subscription is what makes "no acceptance event" a real
  // observation rather than a dead listener reading as silence.
  pipelineEventBus.emit({ type: "postrun:phase:started", phase: "review" });
  const setPostRunPhaseCalls: Array<{ phase: string; update: Record<string, unknown> }> = [];
  // Throws if invoked: an unusable legacy status reader must not break completion.
  const getPostRunStatus = mock((): never => {
    throw new Error("obsolete post-run status read");
  });
  const statusWriter = makeStatusWriter({
    setPostRunPhase: mock((phase: string, update: Record<string, unknown>) => {
      setPostRunPhaseCalls.push({ phase, update });
    }),
    getPostRunStatus,
  });
  try {
    const result = await runCompletionPhase(makeOpts(makeAcceptanceEnabledConfig(), makeCompletePrd(), statusWriter));
    return {
      setPostRunPhaseCalls,
      postRunPhaseStarted,
      getPostRunStatusCalls: getPostRunStatus.mock.calls.length,
      statusUpdates: statusWriter.update.mock.calls.length,
      result,
    };
  } finally {
    unsubscribe();
  }
}

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
  // Hermetic completion + workflow + git. Note what is NOT assigned: there is
  // no acceptance member left on _runnerCompletionDeps to stub.
  _runnerCompletionDeps.handleRunCompletion = mock(async () => baseCompletionResult);
  _runnerCompletionDeps.runWorkflowFeature = mock(async () => null);
  _gitDeps.spawn = makeSpawn().spawn;
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origDeps);
  _gitDeps.spawn = origGitSpawn;
  pipelineEventBus.clear();
  mock.restore();
});

describe("runCompletionPhase — no completion acceptance phase (US-006)", () => {
  test("AC-1: never calls setPostRunPhase with 'acceptance' when acceptance is enabled and the PRD is complete", async () => {
    const observed = await observeCompletion();

    const acceptanceCalls = observed.setPostRunPhaseCalls.filter((call) => call.phase === "acceptance");

    expect(acceptanceCalls).toEqual([]);
    // The run still completed: the phase reached its final status write.
    expect(observed.statusUpdates).toBeGreaterThan(0);
  });

  test("AC-2: emits no postrun:phase:started event whose phase is 'acceptance'", async () => {
    const observed = await observeCompletion();

    const startedPhases = observed.postRunPhaseStarted.map((event) => event.phase);

    // The canary came through, so the listener was live for the whole phase.
    expect(startedPhases).toContain("review");
    expect(startedPhases).not.toContain("acceptance");
  });

  test("AC-3: makes zero calls to statusWriter.getPostRunStatus even when it would throw", async () => {
    const observed = await observeCompletion();

    expect(observed.getPostRunStatusCalls).toBe(0);
    // The unusable reader did not stop completion: the phase still ran to its end.
    expect(observed.statusUpdates).toBeGreaterThan(0);
  });
});
