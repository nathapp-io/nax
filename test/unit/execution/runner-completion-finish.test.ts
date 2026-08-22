/**
 * Tests for the native finish phase's placement, fail-open contract, and
 * `finishStorySummary`'s story-count fallback (#1671).
 *
 * Split out of `runner-completion-postrun.test.ts` (which covers the
 * acceptance-phase `setPostRunPhase` instrumentation, US-002) purely on file
 * size — see `.claude/rules/test-architecture.md`'s "split by describe block"
 * rule. This file owns everything about `runFinishPhase` wiring, including
 * the `storySummary.completed` fallback runner-completion.ts computes for a
 * resumed run that executed no story.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { NaxConfig } from "@/config";
import {
  _runnerCompletionDeps,
  runCompletionPhase,
  type RunnerCompletionOptions,
} from "@/execution/runner-completion";
import type { RunCompletionResult } from "@/execution/lifecycle/run-completion";
import type { LoadedHooksConfig } from "@/hooks";
import { pipelineEventBus } from "@/pipeline/event-bus";
import type { PRD, UserStory } from "@/prd";
import { PluginRegistry } from "@/plugins";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";

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
      regressionGate: { mode: "disabled" },
    },
  });
}

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    setPostRunPhase: mock((_phase: string, _update: Record<string, unknown>) => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  };
}

const WORKDIR = `/tmp/nax-test-runner-completion-finish-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  statusWriter: ReturnType<typeof makeStatusWriter>,
): RunnerCompletionOptions {
  return {
    config,
    hooks: { hooks: {}, _skipGlobal: false } satisfies LoadedHooksConfig,
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
    pluginRegistry: new PluginRegistry([]),
    prdPath: `${WORKDIR}/prd.json`,
  };
}

// Default mock for handleRunCompletion (no regression)
const defaultCompletionResult: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
};

const origDeps = { ..._runnerCompletionDeps };

beforeEach(() => {
  _runnerCompletionDeps.handleRunCompletion = mock(async () => defaultCompletionResult);
  _runnerCompletionDeps.loadConfigForWorkdir = mock(async () => makeConfig(true));
});

afterEach(() => {
  Object.assign(_runnerCompletionDeps, origDeps);
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// finish phase (Task 6) — placement + fail-open + unconditional call
// ---------------------------------------------------------------------------

/**
 * makeOpts() does not build a DispatchContext (runtime/agentManager/sessionManager/
 * abortSignal) — the runner-completion source only ever touches `options.runtime`
 * through optional chaining, so the other describe blocks in this file never
 * needed one. The finish-phase seam does need a real runtime (to observe close()
 * ordering), so this helper layers one on top of makeOpts() the same way other
 * cases here already layer on extra fields (e.g. `featureDir`, `parallel`).
 */
function makeOptsWithRuntime(
  config: NaxConfig,
  prd: PRD,
  statusWriter: ReturnType<typeof makeStatusWriter>,
): RunnerCompletionOptions {
  const runtime = makeTestRuntime({ config });
  return {
    ...makeOpts(config, prd, statusWriter),
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: runtime.signal,
  };
}

describe("finish phase", () => {
  test("runs before the runtime is closed", async () => {
    const order: string[] = [];
    _runnerCompletionDeps.runFinishPhase = mock(async () => {
      order.push("finish");
      return null;
    });
    const opts = makeOptsWithRuntime(makeConfig(false), makePRD([{ id: "US-001", status: "passed" }]), makeStatusWriter());
    // Wrap the runtime's own close so the ordering is observed, not asserted
    // from a fake: makeOptsWithRuntime builds a real tracked runtime.
    const close = opts.runtime.close.bind(opts.runtime);
    opts.runtime.close = async () => {
      order.push("close");
      await close();
    };

    await runCompletionPhase(opts);
    expect(order).toEqual(["finish", "close"]);
  });

  test("a throwing finish phase does not fail the run", async () => {
    _runnerCompletionDeps.runFinishPhase = mock(async () => {
      throw new Error("boom");
    });
    const result = await runCompletionPhase(
      makeOptsWithRuntime(makeConfig(false), makePRD([{ id: "US-001", status: "passed" }]), makeStatusWriter()),
    );
    expect(result.acceptancePassed).toBe(true);
  });

  test("gating is the phase's own concern — the runner always calls it", async () => {
    const calls: unknown[] = [];
    _runnerCompletionDeps.runFinishPhase = mock(async (ctx) => {
      calls.push(ctx);
      return null;
    });
    await runCompletionPhase(
      makeOptsWithRuntime(makeConfig(true), makePRD([{ id: "US-001", status: "failed" }]), makeStatusWriter()),
    );
    expect(calls).toHaveLength(1);
    expect((calls[0] as { storySummary: { failed: number } }).storySummary.failed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // finishStorySummary — #1671: a resumed run whose PRD is already fully
  // complete executes no story, so storiesCompleted stays 0. The summary
  // must backfill from countStories(prd).passed in that one case, and only
  // that case.
  // -------------------------------------------------------------------------

  test("all stories passed with storiesCompleted 0 reports completed === total (#1671)", async () => {
    const calls: unknown[] = [];
    _runnerCompletionDeps.runFinishPhase = mock(async (ctx) => {
      calls.push(ctx);
      return null;
    });
    const opts = {
      ...makeOptsWithRuntime(
        makeConfig(false),
        makePRD([
          { id: "US-001", status: "passed" },
          { id: "US-002", status: "passed" },
        ]),
        makeStatusWriter(),
      ),
      storiesCompleted: 0,
    };
    await runCompletionPhase(opts);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { storySummary: { completed: number } }).storySummary.completed).toBe(2);
  });

  test("a pending story alongside storiesCompleted 0 still reports completed 0 (#1671 sibling case)", async () => {
    const calls: unknown[] = [];
    _runnerCompletionDeps.runFinishPhase = mock(async (ctx) => {
      calls.push(ctx);
      return null;
    });
    const opts = {
      ...makeOptsWithRuntime(
        makeConfig(false),
        makePRD([
          { id: "US-001", status: "passed" },
          { id: "US-002", status: "pending" },
        ]),
        makeStatusWriter(),
      ),
      storiesCompleted: 0,
    };
    await runCompletionPhase(opts);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { storySummary: { completed: number } }).storySummary.completed).toBe(0);
  });

  test("an all-skipped PRD with storiesCompleted 0 backfills to completed: 0 (MEDIUM, pinned deliberately)", async () => {
    // isComplete(prd) treats a "skipped" story as complete, but
    // countStories(prd).passed excludes it — so an all-skipped PRD is
    // "complete" for the isComplete(prd) branch yet contributes 0 to the
    // fallback's `counts.passed`. The gate still blocks (completed: 0),
    // which is CORRECT: a PRD where nothing passed has nothing to ship, so
    // finish must not fire for it. Pinned here because it reads as an
    // oversight otherwise — this is deliberate, not a bug. Do NOT change the
    // predicate to make this case report a nonzero completed count.
    const calls: unknown[] = [];
    _runnerCompletionDeps.runFinishPhase = mock(async (ctx) => {
      calls.push(ctx);
      return null;
    });
    const opts = {
      ...makeOptsWithRuntime(
        makeConfig(false),
        makePRD([
          { id: "US-001", status: "skipped" },
          { id: "US-002", status: "skipped" },
        ]),
        makeStatusWriter(),
      ),
      storiesCompleted: 0,
    };
    await runCompletionPhase(opts);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { storySummary: { completed: number } }).storySummary.completed).toBe(0);
  });

  test("a real run that executed a story keeps its own storiesCompleted, even if the PRD is complete", async () => {
    const calls: unknown[] = [];
    _runnerCompletionDeps.runFinishPhase = mock(async (ctx) => {
      calls.push(ctx);
      return null;
    });
    const opts = {
      ...makeOptsWithRuntime(
        makeConfig(false),
        makePRD([
          { id: "US-001", status: "passed" },
          { id: "US-002", status: "passed" },
        ]),
        makeStatusWriter(),
      ),
      storiesCompleted: 1,
    };
    await runCompletionPhase(opts);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { storySummary: { completed: number } }).storySummary.completed).toBe(1);
  });
});
