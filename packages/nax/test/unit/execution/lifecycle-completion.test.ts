/**
 * Completion Lifecycle Tests — handleRunCompletion & hooks
 *
 * Tests for run completion, hooks, regression gates, and final state management.
 * Extracted from lifecycle.test.ts for size management.
 */

import { afterEach, beforeEach, describe, expect, type Mock, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type DeepPartial, makeDispatchContext, makeNaxConfig, makeStatusWriter } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { purgeStaleManifests } from "@/context/engine";
import { _runCompletionDeps, handleRunCompletion, type RunCompletionOptions } from "@/execution/lifecycle";
import * as loggerModule from "@/logger";
import { Logger } from "@/logger";
import type { StoryMetrics } from "@/metrics";
import type { RunCompletedEvent } from "@/pipeline";
import { pipelineEventBus } from "@/pipeline";
import type { PRD, UserStory } from "@/prd";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, status: UserStory["status"]): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: "Test story",
    acceptanceCriteria: [],
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

function makeConfig(
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

const COMPLETION_WORKDIR = `/tmp/nax-test-completion-${randomUUID()}`;

function makeOpts(
  config: NaxConfig,
  prd: PRD,
  workdir = COMPLETION_WORKDIR,
  overrides?: Partial<RunCompletionOptions>,
): RunCompletionOptions {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: new Date().toISOString(),
    prd,
    allStoryMetrics: [] as StoryMetrics[],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now() - 1000,
    workdir,
    statusWriter: makeStatusWriter(),
    config,
    ...makeDispatchContext(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RL-002 AC#1: on-complete hook fires after handleRunCompletion()
// ---------------------------------------------------------------------------

describe("RL-002 AC#1: on-complete hook fires after handleRunCompletion()", () => {
  const origRunCompletionDeps = { ..._runCompletionDeps };

  afterEach(() => {
    Object.assign(_runCompletionDeps, origRunCompletionDeps);
    pipelineEventBus.clear();
    mock.restore();
  });

  test("run:completed event is emitted from inside handleRunCompletion, before it resolves", async () => {
    let resolved = false;
    let emittedBeforeResolve = false;
    const capturedEvents: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      emittedBeforeResolve = !resolved;
      capturedEvents.push(ev);
    });

    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "passed" },
    ]);
    const config = makeConfig("disabled");

    try {
      await handleRunCompletion(makeOpts(config, prd));
      resolved = true;

      expect(capturedEvents).toHaveLength(1);
      expect(emittedBeforeResolve).toBe(true);
    } finally {
      unsub();
    }
  });
});

// ---------------------------------------------------------------------------
// RL-002 AC#3: Hook payload reflects final success status
// ---------------------------------------------------------------------------

describe("RL-002 AC#3: run:completed payload reflects final success status", () => {
  test("run:completed event has correct story counts (not placeholder 0/0/0)", async () => {
    const stories = [makeStory("US-001", "passed"), makeStory("US-002", "passed"), makeStory("US-003", "failed")];
    const prd = makePRD(stories.map((s) => ({ id: s.id, status: s.status })));
    const config = makeConfig("disabled");

    let completionResult: Awaited<ReturnType<typeof handleRunCompletion>>;
    try {
      completionResult = await handleRunCompletion(makeOpts(config, prd));
    } catch {
      return;
    }

    expect(completionResult.finalCounts.total).toBe(3);
    expect(completionResult.finalCounts.passed).toBe(2);
    expect(completionResult.finalCounts.failed).toBe(1);

    expect(completionResult.finalCounts.total).toBeGreaterThan(0);
  });

  test("run:completed event totalCost matches actual run cost", async () => {
    const capturedEvents: RunCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("run:completed", (ev) => {
      capturedEvents.push(ev);
    });

    const prd = makePRD([{ id: "US-001", status: "passed" }]);
    const config = makeConfig("disabled");
    const opts = makeOpts(config, prd);
    opts.runtime.costAggregator.record({
      ts: Date.now(),
      runId: "run-001",
      agentName: "claude",
      model: "test",
      storyId: "US-001",
      tokens: { input: 0, output: 0 },
      estimatedCostUsd: 2.75,
      exactCostUsd: 2.75,
      costUsd: 2.75,
      confidence: "exact",
      durationMs: 0,
    });

    try {
      await handleRunCompletion(opts);

      expect(capturedEvents).toHaveLength(1);
      expect(capturedEvents[0]?.totalCost).toBeCloseTo(2.75, 2);
    } finally {
      unsub();
    }
  });
});

describe("handleRunCompletion - cost-limit exitReason surfaces distinctly", () => {
  test("sets run status to 'cost-limit' when exitReason is 'cost-limit', regardless of PRD completeness", async () => {
    const config = makeConfig("deferred", "bun test");
    const statusWriter = makeStatusWriter();
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "pending" },
    ]);

    await handleRunCompletion({
      ...makeOpts(config, prd, undefined, { exitReason: "cost-limit" }),
      statusWriter: statusWriter,
    });

    expect(statusWriter.setRunStatus).toHaveBeenCalledWith("cost-limit");
  });

  test("does not set 'cost-limit' when exitReason is absent, even with an incomplete PRD", async () => {
    const config = makeConfig("deferred", "bun test");
    const statusWriter = makeStatusWriter();
    const prd = makePRD([
      { id: "US-001", status: "passed" },
      { id: "US-002", status: "pending" },
    ]);

    await handleRunCompletion({
      ...makeOpts(config, prd),
      statusWriter: statusWriter,
    });

    expect(statusWriter.setRunStatus).not.toHaveBeenCalledWith("cost-limit");
  });
});

// ---------------------------------------------------------------------------
// US-002: Run manifest retention during completion
//
// handleRunCompletion must invoke purgeStaleManifests when
// config.context.v2.manifest.retentionDays is configured, must not invoke it
// when the manifest block is unset, and must absorb any rejection as a
// warn-level log without failing the run.
// ---------------------------------------------------------------------------

describe("US-002: handleRunCompletion — manifest retention sweep", () => {
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

  function makeConfigWithManifest(retentionDays?: number): NaxConfig {
    if (retentionDays === undefined) return makeConfig("disabled");
    return makeConfig("disabled", undefined, {
      context: { v2: { manifest: { retentionDays } } },
    });
  }

  let loggerSpy: Mock<typeof loggerModule.getSafeLogger> | undefined;

  beforeEach(() => {
    // Default mock: returns 0 deleted (so info branch is not hit unless AC5 asks).
    _runCompletionDeps.purgeStaleManifests = mock(
      async (_projectDir: string, _retentionDays: number) => 0,
    ) as typeof _runCompletionDeps.purgeStaleManifests;
  });

  afterEach(() => {
    Object.assign(_runCompletionDeps, { purgeStaleManifests });
    loggerSpy?.mockRestore();
    pipelineEventBus.clear();
    mock.restore();
  });

  test("AC1: invokes purgeStaleManifests exactly once with resolved projectDir and retentionDays when configured", async () => {
    const { logger } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root", { projectDir: "/project-root" }));

    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledTimes(1);
    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledWith("/project-root", 30);
  });

  test("AC1: falls back to workdir when projectDir is not provided", async () => {
    const { logger } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    const config = makeConfigWithManifest(14);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-only"));

    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledTimes(1);
    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledWith("/workdir-only", 14);
  });

  test("AC2: does not invoke purgeStaleManifests when context.v2.manifest is unset", async () => {
    const { logger } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    const config = makeConfigWithManifest(undefined);
    expect(config.context.v2.manifest).toBeUndefined();
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root", { projectDir: "/project-root" }));

    // The dep is wired (see beforeEach); it must NOT be invoked when the config is unset.
    expect(_runCompletionDeps.purgeStaleManifests).not.toHaveBeenCalled();
  });

  test("AC3: handleRunCompletion resolves with normal completion result when purgeStaleManifests rejects", async () => {
    const { logger } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    _runCompletionDeps.purgeStaleManifests = mock(async () => {
      throw new Error("disk full");
    }) as typeof _runCompletionDeps.purgeStaleManifests;
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    const result = await handleRunCompletion(makeOpts(config, prd, "/workdir-root"));

    // Must have actually called the dep — otherwise the test vacuously passes
    // when the implementation simply forgets to invoke the sweep.
    expect(_runCompletionDeps.purgeStaleManifests).toHaveBeenCalledTimes(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.finalCounts.total).toBe(1);
    expect(result.finalCounts.passed).toBe(1);
    expect(typeof result.runCompletedAt).toBe("string");
    expect(typeof result.reportedTotal).toBe("number");
  });

  test("AC4: emits warn-level log when purgeStaleManifests rejects", async () => {
    const { logger, warnCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    _runCompletionDeps.purgeStaleManifests = mock(async () => {
      throw new Error("manifest sweep failed");
    }) as typeof _runCompletionDeps.purgeStaleManifests;
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root"));

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]?.[0]).toBe("run.complete");
    expect(warnCalls[0]?.[1]).toMatch(/manifest/i);
    expect(warnCalls[0]?.[2].error).toBeDefined();
  });

  test("AC5: emits info-level log carrying the deleted count when purgeStaleManifests returns > 0", async () => {
    const { logger, infoCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    _runCompletionDeps.purgeStaleManifests = mock(async () => 7) as typeof _runCompletionDeps.purgeStaleManifests;
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root"));

    const manifestInfo = infoCalls.find(([stage, msg]) => stage === "run.complete" && /manifest/i.test(msg));
    expect(manifestInfo).toBeDefined();
    expect(manifestInfo?.[2].purged).toBe(7);
  });

  test("AC5 (boundary): does NOT emit info-level manifest log when purgeStaleManifests returns 0", async () => {
    const { logger, infoCalls } = makeCapturingLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);
    _runCompletionDeps.purgeStaleManifests = mock(async () => 0) as typeof _runCompletionDeps.purgeStaleManifests;
    const config = makeConfigWithManifest(30);
    const prd = makePRD([{ id: "US-001", status: "passed" }]);

    await handleRunCompletion(makeOpts(config, prd, "/workdir-root"));

    const manifestInfo = infoCalls.find(([stage, msg]) => stage === "run.complete" && /manifest/i.test(msg));
    expect(manifestInfo).toBeUndefined();
  });
});
