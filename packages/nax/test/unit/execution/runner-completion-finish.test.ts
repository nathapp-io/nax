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
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeDispatchContext,
  makePRD as makeFixturePRD,
  makeMockRuntime,
  makeNaxConfig,
  makeSpawn,
  makeStatusWriter,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { AcceptanceLoopContext } from "@/execution/lifecycle/acceptance-loop";
import type { RunCompletionOptions, RunCompletionResult } from "@/execution/lifecycle/run-completion";
import { _runnerCompletionDeps, type RunnerCompletionOptions, runCompletionPhase } from "@/execution/runner-completion";
import { StatusWriter } from "@/execution/status-writer";
import type { FinishPhaseContext } from "@/finish";
import type { LoadedHooksConfig } from "@/hooks";
import { InteractionChain } from "@/interaction";
import { pipelineEventBus } from "@/pipeline/event-bus";
import { PluginRegistry } from "@/plugins";
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
      regressionGate: { mode: "disabled" },
    },
  });
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
    ...makeDispatchContext(),
  };
}

// Default mock for handleRunCompletion (no regression)
const defaultCompletionResult: RunCompletionResult = {
  durationMs: 100,
  runCompletedAt: new Date().toISOString(),
  reportedTotal: 0,
  pluginGateFailed: false,
  finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
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
  return {
    ...makeOpts(config, prd, statusWriter),
    ...makeDispatchContext({ runtime: makeTestRuntime({ config }) }),
  };
}

describe("finish phase", () => {
  test.each(["passed", "escalated", "skipped", "throw"])(
    "persists final status and spend after finish: %s",
    async (outcome) => {
      const dir = makeTempDir("finish-persistence-");
      const featureDir = join(dir, "feature");
      mkdirSync(featureDir);
      const config = makeConfig(false);
      const prd = makeFixturePRD({ userStories: [makeStory("US-001", "passed")] });
      const writer = new StatusWriter(join(dir, "status.json"), config, {
        runId: "run-001",
        feature: "test-feature",
        startedAt: new Date().toISOString(),
        dryRun: false,
        startTimeMs: Date.now(),
        pid: process.pid,
      });
      writer.setPrd(prd);
      const runtime = makeMockRuntime({ config, workdir: dir });
      const recordCost = (costUsd: number) =>
        runtime.costAggregator.record({
          ts: Date.now(),
          runId: "run-001",
          agentName: "native",
          model: "test",
          estimatedCostUsd: costUsd,
          exactCostUsd: costUsd,
          costUsd,
          confidence: "exact",
          durationMs: 1,
        });
      recordCost(0.0745);
      _runnerCompletionDeps.handleRunCompletion = mock(async () => {
        writer.setRunStatus("completed");
        await writer.update(0.0745, 1);
        return { ...defaultCompletionResult, reportedTotal: 0.0745 };
      });
      _runnerCompletionDeps.runFinishPhase = mock(async () => {
        recordCost(0.06);
        runtime.costAggregator.recordError({
          kind: "error",
          ts: Date.now(),
          runId: "run-001",
          agentName: "native",
          errorCode: "FINISH_DISPATCH_FAILED",
          durationMs: 1,
          costUsd: 0.0228,
        });
        writer.setPostRunPhase("finish", {
          status: outcome === "passed" ? "passed" : outcome === "skipped" ? "skipped" : "failed",
          ...(outcome === "escalated"
            ? { result: "escalated", url: "https://github.com/o/r/pull/1", escalationReason: "Review blocked" }
            : {}),
        });
        if (outcome === "throw") throw new Error("finish failed after recording status");
        return null;
      });
      const originalSpawn = _gitDeps.spawn;
      _gitDeps.spawn = makeSpawn().spawn;
      try {
        const result = await runCompletionPhase({
          ...makeOpts(config, prd, makeStatusWriter()),
          workdir: dir,
          statusWriter: writer,
          featureDir,
          ...makeDispatchContext({ runtime }),
        });
        for (const statusPath of [join(dir, "status.json"), join(featureDir, "status.json")]) {
          const status = await Bun.file(statusPath).json();
          expect(status.postRun?.finish?.status).toBe(
            outcome === "passed" ? "passed" : outcome === "skipped" ? "skipped" : "failed",
          );
          expect(status.cost.spent).toBeCloseTo(0.1573, 4);
          expect(status.run.status).toBe("completed");
          if (outcome === "escalated") {
            expect(status.postRun.finish.result).toBe("escalated");
            expect(status.postRun.finish.url).toBe("https://github.com/o/r/pull/1");
            expect(status.postRun.finish.escalationReason).toBe("Review blocked");
          }
        }
        expect(result.reportedTotal).toBeCloseTo(0.1573, 4);
      } finally {
        _gitDeps.spawn = originalSpawn;
        await runtime.close();
        cleanupTempDir(dir);
      }
    },
  );

  test("runs before the runtime is closed", async () => {
    const order: string[] = [];
    _runnerCompletionDeps.runFinishPhase = mock(async () => {
      order.push("finish");
      return null;
    });
    const opts = makeOptsWithRuntime(
      makeConfig(false),
      makePRD([{ id: "US-001", status: "passed" }]),
      makeStatusWriter(),
    );
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

// ---------------------------------------------------------------------------
// #2201: every post-run Bash-dispatching site gets the run's interaction chain
// (the human link of its ask resolver) and the finish phase the run's package
// dirs (the approvals cache's run-wide raw check).
// ---------------------------------------------------------------------------

describe("post-run ask wiring inputs (#2201)", () => {
  test("the interaction chain reaches acceptance, completion (regression) and finish", async () => {
    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const chain = new InteractionChain({ defaultTimeout: 1000, defaultFallback: "abort" });
    const acceptanceCtxs: AcceptanceLoopContext[] = [];
    const completionOpts: RunCompletionOptions[] = [];
    const finishCtxs: FinishPhaseContext[] = [];
    _runnerCompletionDeps.runAcceptanceLoop = mock(async (ctx: AcceptanceLoopContext) => {
      acceptanceCtxs.push(ctx);
      return { success: true, prd, totalCost: 0, iterations: 1, storiesCompleted: 1, prdDirty: false };
    });
    _runnerCompletionDeps.handleRunCompletion = mock(async (opts: RunCompletionOptions) => {
      completionOpts.push(opts);
      return defaultCompletionResult;
    });
    _runnerCompletionDeps.runFinishPhase = mock(async (ctx: FinishPhaseContext) => {
      finishCtxs.push(ctx);
      return null;
    });

    await runCompletionPhase({
      ...makeOptsWithRuntime(makeConfig(true), prd, makeStatusWriter()),
      interactionChain: chain,
    });

    expect(acceptanceCtxs[0]?.interactionChain).toBe(chain);
    expect(completionOpts[0]?.interactionChain).toBe(chain);
    expect(finishCtxs[0]?.interactionChain).toBe(chain);
    expect(finishCtxs[0]?.packageDirs).toEqual([undefined]);
  });
});
