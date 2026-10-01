/**
 * Characterisation tests for handleRunCompletion's unpinned branches
 * (complexity-drain batch A9, before refactoring run-completion.ts).
 *
 * The seven run-completion* mirror suites pin most of the function: regression
 * gate events (US-004 AC7/AC8/AC9), back-fill and merge (#679, #1709, #1721),
 * Bug 909 aggregator totals, plugin-review gating (#1146 G2), session teardown,
 * manifest retention (US-002), regression-failed story marking and run status
 * (RL-004), and the cost-limit exit reason. NOTHING pinned the branches below,
 * so they are pinned here, green against the unrefactored function, before any
 * structural change:
 *
 *  1. a thrown regression gate emits the failed postrun:phase:completed event,
 *     then rethrows the SAME error (post-impl-review quality finding);
 *  2. the on-final-regression-fail hook fires with the regression result — and
 *     does not fire when hooksConfig is absent;
 *  3. skipRegression: true skips the deferred gate entirely;
 *  4. isSequential === false withholds per-story snapshots from the gate
 *     (#1527/#1528) while sequential runs project them;
 *  5. the AC-20 session-scratch purge half (manifest half is pinned):
 *     resolved projectDir, archive-on-feature-archive flag, info/warn logs,
 *     and that the schema-default session block (retentionDays 7) purges with
 *     no explicit override. The no-retention no-op is NOT pinned: the
 *     `if (sessionCfg?.retentionDays)` false arm is unreachable through a
 *     validated config (schema min(1));
 *  6. pluginProviderCache.disposeAll() is awaited during completion;
 *  7. the saveRunMetrics payload shape (runId, counts, stories reference);
 *  8. the final-status ternary's "stalled" and "aborted" arms (EXEC-1);
 *  9. AC-25: contextCostUsd summed into the completion log (field omitted at
 *     zero).
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type DeepPartial, makeDispatchContext, makeNaxConfig, makeStatusWriter, makeStory } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { PluginProviderCache } from "@/context/engine";
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "@/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "@/execution/lifecycle/run-regression";
import type { HooksConfig } from "@/hooks/types";
import * as loggerModule from "@/logger";
import { Logger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import * as metricsModule from "@/metrics";
import type { PostRunPhaseCompletedEvent, PostRunPhaseStartedEvent } from "@/pipeline";
import { pipelineEventBus } from "@/pipeline";
import type { PRD, UserStory } from "@/prd";
import * as sessionModule from "@/session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LogCall = [string, string, Record<string, unknown>];

function makeCapturingLogger() {
  const infoCalls: LogCall[] = [];
  const warnCalls: LogCall[] = [];
  const base = new Logger({ level: "silent" });
  const logger = new Logger({ level: "silent" });
  logger.info = (stage: string, msg: string, ctx: Record<string, unknown>) => {
    infoCalls.push([stage, msg, ctx]);
    return base.info(stage, msg, ctx);
  };
  logger.warn = (stage: string, msg: string, ctx: Record<string, unknown>) => {
    warnCalls.push([stage, msg, ctx]);
    return base.warn(stage, msg, ctx);
  };
  return { logger, infoCalls, warnCalls };
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function edgeConfig(
  regressionMode?: "deferred" | "per-story" | "disabled",
  testCommand?: string,
  extra: DeepPartial<NaxConfig> = {},
): NaxConfig {
  return makeNaxConfig({
    execution: {
      regressionGate: {
        enabled: true,
        timeoutSeconds: 30,
        acceptOnTimeout: true,
        ...(regressionMode !== undefined ? { mode: regressionMode } : {}),
      },
    },
    quality: {
      commands: {
        ...(testCommand ? { test: testCommand } : {}),
      },
    },
    ...extra,
  });
}

function makeStoryMetrics(overrides: Partial<StoryMetrics> = {}): StoryMetrics {
  return {
    storyId: "US-001",
    complexity: "simple",
    modelTier: "standard",
    modelUsed: "claude-sonnet-4-5",
    attempts: 1,
    finalTier: "standard",
    success: true,
    cost: 0.01,
    durationMs: 1000,
    firstPassSuccess: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    fullSuiteGatePassed: true,
    ...overrides,
  };
}

const WORKDIR = `/tmp/nax-test-run-completion-edges-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  overrides?: Partial<RunCompletionOptions> & { statusWriter?: ReturnType<typeof makeStatusWriter> },
): RunCompletionOptions {
  const { statusWriter, ...rest } = overrides ?? {};
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: "2026-01-01T00:00:00.000Z",
    prd,
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir: WORKDIR,
    statusWriter: statusWriter ?? makeStatusWriter(),
    config,
    ...makeDispatchContext(),
    ...rest,
  };
}

function makeSuccessfulRegression(): DeferredRegressionResult {
  return {
    success: true,
    failedTests: 0,
    failedTestFiles: [],
    passedTests: 5,
    rectificationAttempts: 0,
    affectedStories: [],
  };
}

function makeFailedRegression(): DeferredRegressionResult {
  return {
    success: false,
    failedTests: 2,
    failedTestFiles: ["a.test.ts", "b.test.ts"],
    passedTests: 3,
    rectificationAttempts: 1,
    affectedStories: ["US-001"],
  };
}

const origDeps = { ..._runCompletionDeps };
let loggerSpy: Mock<typeof loggerModule.getSafeLogger> | undefined;

beforeEach(() => {
  _runCompletionDeps.runDeferredRegression = mock(
    async (): Promise<DeferredRegressionResult> => makeSuccessfulRegression(),
  );
  pipelineEventBus.clear();
});

afterEach(() => {
  Object.assign(_runCompletionDeps, origDeps);
  loggerSpy?.mockRestore();
  loggerSpy = undefined;
  pipelineEventBus.clear();
  mock.restore();
});

// ---------------------------------------------------------------------------
// 1. Regression-gate throw: failed event emitted, then the SAME error rethrown
// ---------------------------------------------------------------------------

describe("handleRunCompletion — regression-gate throw path", () => {
  test("a throwing gate emits the failed postrun:phase:completed event, then rethrows the same error", async () => {
    const started: PostRunPhaseStartedEvent[] = [];
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:started", (e) => {
      started.push(e);
    });
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      completed.push(e);
    });

    const sentinel = new Error("regression boom");
    _runCompletionDeps.runDeferredRegression = mock(async (): Promise<DeferredRegressionResult> => {
      throw sentinel;
    });

    const statusWriter = makeStatusWriter();
    let caught: unknown;
    try {
      await handleRunCompletion(
        makeOpts(edgeConfig("deferred", "bun test"), makePrd([makeStory({ id: "US-001" })]), { statusWriter }),
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBe(sentinel);
    // The throw must not leave "regression" permanently "running" — the catch
    // emits the completed event with passed:false before rethrowing.
    expect(started.some((e) => e.phase === "regression")).toBe(true);
    const failureEvent = completed.find((e) => e.phase === "regression");
    expect(failureEvent).toBeDefined();
    expect(failureEvent?.passed).toBe(false);
    expect(typeof failureEvent?.durationMs).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// 2. on-final-regression-fail hook
// ---------------------------------------------------------------------------

describe("handleRunCompletion — on-final-regression-fail hook", () => {
  test("fires with the regression failure payload when hooksConfig is present", async () => {
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => makeFailedRegression(),
    );
    const fireHook = mock(async (..._args: Parameters<typeof _runCompletionDeps.fireHook>) => {});
    _runCompletionDeps.fireHook = fireHook;
    const hooksConfig: HooksConfig = { hooks: {} };

    await handleRunCompletion(
      makeOpts(
        edgeConfig("deferred", "bun test"),
        makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]),
        {
          hooksConfig,
        },
      ),
    );

    expect(fireHook).toHaveBeenCalledTimes(1);
    const [cfg, event, payload, dir] = fireHook.mock.calls[0];
    expect(cfg).toBe(hooksConfig);
    expect(event).toBe("on-final-regression-fail");
    expect(payload).toMatchObject({
      event: "on-final-regression-fail",
      feature: "test-feature",
      status: "failed",
      failedTests: 2,
      affectedStories: ["US-001"],
    });
    expect(dir).toBe(WORKDIR);
  });

  test("does not fire when hooksConfig is absent, even on regression failure", async () => {
    _runCompletionDeps.runDeferredRegression = mock(
      async (): Promise<DeferredRegressionResult> => makeFailedRegression(),
    );
    const fireHook = mock(async () => {});
    _runCompletionDeps.fireHook = fireHook;

    await handleRunCompletion(
      makeOpts(
        edgeConfig("deferred", "bun test"),
        makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]),
      ),
    );

    expect(fireHook).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. skipRegression: true
// ---------------------------------------------------------------------------

describe("handleRunCompletion — skipRegression", () => {
  test("skips the deferred gate entirely and completes normally", async () => {
    const statusWriter = makeStatusWriter();
    const started: PostRunPhaseStartedEvent[] = [];
    const completed: PostRunPhaseCompletedEvent[] = [];
    pipelineEventBus.on("postrun:phase:started", (e) => {
      started.push(e);
    });
    pipelineEventBus.on("postrun:phase:completed", (e) => {
      completed.push(e);
    });

    const result = await handleRunCompletion(
      makeOpts(
        edgeConfig("deferred", "bun test"),
        makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]),
        {
          statusWriter,
          skipRegression: true,
        },
      ),
    );

    expect(_runCompletionDeps.runDeferredRegression).not.toHaveBeenCalled();
    expect(started.some((e) => e.phase === "regression")).toBe(false);
    expect(completed.some((e) => e.phase === "regression")).toBe(false);
    expect(statusWriter.setPostRunPhase).not.toHaveBeenCalledWith("regression", expect.anything());
    expect(result.pluginGateFailed).toBe(false);
    expect(result.finalCounts.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. isSequential === false withholds per-story snapshots (#1527/#1528)
// ---------------------------------------------------------------------------

describe("handleRunCompletion — per-story snapshot forwarding to the gate", () => {
  test("passes storyMetrics: undefined when isSequential is false", async () => {
    const metrics = [makeStoryMetrics({ failingTestFiles: ["a.test.ts"] })];
    await handleRunCompletion(
      makeOpts(
        edgeConfig("deferred", "bun test"),
        makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]),
        {
          allStoryMetrics: metrics,
          isSequential: false,
        },
      ),
    );

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledTimes(1);
    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledWith(
      expect.objectContaining({ storyMetrics: undefined }),
    );
  });

  test("projects storyId, completedAt and failingTestFiles when sequential", async () => {
    const metrics = [makeStoryMetrics({ failingTestFiles: ["a.test.ts"] })];
    await handleRunCompletion(
      makeOpts(
        edgeConfig("deferred", "bun test"),
        makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]),
        {
          allStoryMetrics: metrics,
          isSequential: true,
        },
      ),
    );

    expect(_runCompletionDeps.runDeferredRegression).toHaveBeenCalledWith(
      expect.objectContaining({
        storyMetrics: [
          {
            storyId: "US-001",
            completedAt: "2026-01-01T00:01:00.000Z",
            failingTestFiles: ["a.test.ts"],
          },
        ],
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. AC-20 session-scratch purge half
// ---------------------------------------------------------------------------

describe("handleRunCompletion — session scratch purge (AC-20)", () => {
  function configWithSession(extra: DeepPartial<NaxConfig>["context"]): NaxConfig {
    return edgeConfig("disabled", undefined, { context: extra });
  }

  test("purges with resolved projectDir and archive=false for an incomplete feature", async () => {
    const purge = spyOn(sessionModule, "purgeStaleScratch").mockResolvedValue(0);
    const prd = makePrd([makeStory({ id: "US-001", status: "passed", passes: true }), makeStory({ id: "US-002" })]);

    await handleRunCompletion(
      makeOpts(configWithSession({ v2: { session: { retentionDays: 7, archiveOnFeatureArchive: true } } }), prd, {
        projectDir: "/project-root",
      }),
    );

    expect(purge).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledWith("/project-root", "test-feature", 7, false);
  });

  test("archives instead of deleting only when the feature is complete and opted in", async () => {
    const purge = spyOn(sessionModule, "purgeStaleScratch").mockResolvedValue(0);
    const prd = makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]);

    await handleRunCompletion(
      makeOpts(configWithSession({ v2: { session: { retentionDays: 7, archiveOnFeatureArchive: true } } }), prd),
    );
    expect(purge).toHaveBeenLastCalledWith(WORKDIR, "test-feature", 7, true);

    await handleRunCompletion(
      makeOpts(configWithSession({ v2: { session: { retentionDays: 7, archiveOnFeatureArchive: false } } }), prd),
    );
    expect(purge).toHaveBeenLastCalledWith(WORKDIR, "test-feature", 7, false);
  });

  test("purged > 0 logs the count; rejection is absorbed as a warn and completion continues", async () => {
    const { logger, infoCalls, warnCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    const purge = spyOn(sessionModule, "purgeStaleScratch");
    const prd = makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]);

    purge.mockResolvedValue(2);
    await handleRunCompletion(makeOpts(configWithSession({ v2: { session: { retentionDays: 7 } } }), prd));
    const infoCall = infoCalls.find(([, msg]) => msg === "Purged stale session scratch dirs");
    expect(infoCall).toBeDefined();
    expect(infoCall?.[2]).toMatchObject({ feature: "test-feature", purged: 2 });

    purge.mockRejectedValue(new Error("disk gone"));
    const result = await handleRunCompletion(
      makeOpts(configWithSession({ v2: { session: { retentionDays: 7 } } }), prd),
    );
    expect(result.pluginGateFailed).toBe(false);
    expect(result.finalCounts.total).toBe(1);
    const warnCall = warnCalls.find(([, msg]) => msg === "Failed to purge stale session scratch");
    expect(warnCall).toBeDefined();
  });

  test("the schema-default session block (retentionDays 7) triggers the purge with no explicit override", async () => {
    // context.v2.session defaults to { retentionDays: 7, archiveOnFeatureArchive: true },
    // so a config with NO context block still purges — the `if (sessionCfg?.retentionDays)`
    // guard's false arm is unreachable through a validated config (min(1) on the schema).
    const purge = spyOn(sessionModule, "purgeStaleScratch").mockResolvedValue(0);
    const prd = makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]);

    await handleRunCompletion(makeOpts(edgeConfig("disabled"), prd));

    // Feature is complete, so the archive flag is true even with the default archiveOnFeatureArchive.
    expect(purge).toHaveBeenCalledWith(WORKDIR, "test-feature", 7, true);
  });
});

// ---------------------------------------------------------------------------
// 6. pluginProviderCache disposal
// ---------------------------------------------------------------------------

describe("handleRunCompletion — plugin provider cache disposal", () => {
  test("disposes the per-run plugin provider cache during completion", async () => {
    const cache = new PluginProviderCache();
    const disposeAll = spyOn(cache, "disposeAll").mockResolvedValue(undefined);
    const prd = makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]);

    await handleRunCompletion(makeOpts(edgeConfig("disabled"), prd, { pluginProviderCache: cache }));

    expect(disposeAll).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7. saveRunMetrics payload
// ---------------------------------------------------------------------------

describe("handleRunCompletion — saved run-metrics payload", () => {
  test("saveRunMetrics receives the full run payload with the live metrics array", async () => {
    const save = spyOn(metricsModule, "saveRunMetrics").mockResolvedValue(undefined);
    const metrics = [makeStoryMetrics()];
    const prd = makePrd([
      makeStory({ id: "US-001", status: "passed", passes: true }),
      makeStory({ id: "US-002", status: "failed", passes: false }),
    ]);

    await handleRunCompletion(makeOpts(edgeConfig("disabled"), prd, { allStoryMetrics: metrics, storiesCompleted: 1 }));

    expect(save).toHaveBeenCalledTimes(1);
    const [outputDir, payload] = save.mock.calls[0];
    expect(typeof outputDir).toBe("string");
    // applyBackfill runs BEFORE the save: the failed story with no execution
    // metric gets a synthetic row, so the payload carries 2 stories, not 1 —
    // and `stories` is the live, mutated allStoryMetrics array itself.
    expect(payload).toMatchObject({
      runId: "run-001",
      feature: "test-feature",
      startedAt: "2026-01-01T00:00:00.000Z",
      totalStories: 2,
      storiesCompleted: 1,
      storiesFailed: 1,
    });
    expect(typeof payload.completedAt).toBe("string");
    expect(typeof payload.totalDurationMs).toBe("number");
    expect(payload.stories).toBe(metrics);
    expect("fallback" in payload).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Final-status ternary: stalled and aborted arms (EXEC-1)
// ---------------------------------------------------------------------------

describe("handleRunCompletion — final-status arms", () => {
  test("an incomplete, non-stalled run ends 'aborted' — not 'running' (EXEC-1)", async () => {
    const statusWriter = makeStatusWriter();
    const prd = makePrd([makeStory({ id: "US-001", status: "passed", passes: true }), makeStory({ id: "US-002" })]);

    await handleRunCompletion(makeOpts(edgeConfig("disabled"), prd, { statusWriter }));

    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("aborted");
  });

  test("a run whose remaining stories have exhausted retries ends 'stalled'", async () => {
    const statusWriter = makeStatusWriter();
    const prd = makePrd([makeStory({ id: "US-001", status: "failed", passes: false, attempts: 13 })]);

    await handleRunCompletion(makeOpts(edgeConfig("disabled"), prd, { statusWriter }));

    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("stalled");
  });
});

// ---------------------------------------------------------------------------
// 9. AC-25: contextCostUsd in the completion log
// ---------------------------------------------------------------------------

describe("handleRunCompletion — completion log context cost (AC-25)", () => {
  test("sums context provider cost across all stories into the completion log", async () => {
    const { logger, infoCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    const metrics = [
      makeStoryMetrics({ storyId: "US-001", context: { providers: { alpha: providerMetrics(0.25) } } }),
      makeStoryMetrics({ storyId: "US-002", context: { providers: { beta: providerMetrics(0.75) } } }),
    ];
    const prd = makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]);

    await handleRunCompletion(makeOpts(edgeConfig("disabled"), prd, { allStoryMetrics: metrics }));

    const completion = infoCalls.find(([, msg]) => msg === "Feature execution completed");
    expect(completion).toBeDefined();
    expect(completion?.[2].contextCostUsd).toBe(1);
  });

  test("omits contextCostUsd when no story carries provider cost", async () => {
    const { logger, infoCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    const prd = makePrd([makeStory({ id: "US-001", status: "passed", passes: true })]);

    await handleRunCompletion(makeOpts(edgeConfig("disabled"), prd, { allStoryMetrics: [makeStoryMetrics()] }));

    const completion = infoCalls.find(([, msg]) => msg === "Feature execution completed");
    expect(completion).toBeDefined();
    const logCtx = completion?.[2] ?? {};
    expect("contextCostUsd" in logCtx).toBe(false);
  });
});

function providerMetrics(costUsd: number) {
  return {
    tokensProduced: 10,
    chunksProduced: 1,
    chunksKept: 1,
    wallClockMs: 5,
    timedOut: false,
    failed: false,
    costUsd,
  };
}
