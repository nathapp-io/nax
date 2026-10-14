/**
 * nax#2491: in workflow mode the `run.complete` log line is held back until the feature workflow
 * has run, then written with the whole run's duration and the stories / feature-workflow split.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  assertDefined,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { RunCompletionOptions } from "@/execution";
import { handleRunCompletion } from "@/execution";
import { logRunCompletion } from "@/execution/lifecycle/run-completion-phases";
import { addSink, getSafeLogger, initLogger, type LogEntry, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline";
import { countStories, type PRD, type UserStory } from "@/prd";
import { type CostSnapshot, createNoOpCostAggregator, type ICostAggregator } from "@/runtime";

const WORKDIR = `/tmp/nax-test-run-completion-wf-duration-${randomUUID()}`;

function prd(): PRD {
  return {
    project: "p",
    feature: "f",
    branchName: "b",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [
      makeStory({ id: "US-001", title: "t", description: "d", status: "passed", passes: true, attempts: 1 }),
    ] as UserStory[],
  };
}

function opts(over: Partial<RunCompletionOptions> = {}): RunCompletionOptions {
  return {
    runId: "run-001",
    feature: "f",
    startedAt: new Date().toISOString(),
    prd: prd(),
    allStoryMetrics: [],
    totalCost: 0,
    storiesCompleted: 1,
    iterations: 1,
    startTime: Date.now() - 50,
    workdir: WORKDIR,
    statusWriter: makeStatusWriter(),
    config: makeNaxConfig({ execution: { regressionGate: { mode: "disabled" } } }),
    runtime: makeMockRuntime(),
    agentManager: makeMockAgentManager(),
    sessionManager: makeSessionManager(),
    abortSignal: new AbortController().signal,
    ...over,
  };
}

let logs: LogEntry[] = [];
beforeEach(() => {
  pipelineEventBus.clear();
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => {
  resetLogger();
  pipelineEventBus.clear();
});

const FINAL = {
  durationMs: 9_448_000,
  storiesDurationMs: 8_393_000,
  featureWorkflowDurationMs: 1_055_000,
  totalCost: 4.25,
  workflowPassed: true,
};

const completes = () => logs.filter((e) => e.stage === "run.complete" && e.message === "Feature execution completed");

describe("handleRunCompletion — run.complete in workflow mode (nax#2491)", () => {
  test("pipeline mode logs run.complete immediately, with no split fields", async () => {
    const result = await handleRunCompletion(opts());
    expect(completes()).toHaveLength(1);
    expect(completes()[0]?.data).not.toHaveProperty("featureWorkflowDurationMs");
    expect(result.logRunComplete).toBeUndefined();
  });

  test("deferRunCompleteLog holds the line back and hands the caller a logger for it", async () => {
    const result = await handleRunCompletion(opts({ deferRunCompleteLog: true }));
    expect(completes()).toHaveLength(0);
    expect(result.logRunComplete).toBeFunction();
  });

  test("the deferred line carries the whole-run duration, both parts and the final cost", async () => {
    const result = await handleRunCompletion(opts({ deferRunCompleteLog: true }));
    result.logRunComplete?.({ ...FINAL, workflowPassed: true });
    expect(completes()).toHaveLength(1);
    expect(completes()[0]?.data).toMatchObject({
      durationMs: 9_448_000,
      storiesDurationMs: 8_393_000,
      featureWorkflowDurationMs: 1_055_000,
      totalCost: 4.25,
      success: true,
    });
  });

  test("success is false when the feature workflow did not pass", async () => {
    const result = await handleRunCompletion(opts({ deferRunCompleteLog: true }));
    result.logRunComplete?.({ ...FINAL, workflowPassed: false });
    expect(completes()[0]?.data).toMatchObject({ success: false });
  });
});

describe("handleRunCompletion — the end-phase split on run.complete (nax#2494)", () => {
  test("the deferred line carries endPhaseDurationMs and no workflow split", async () => {
    const result = await handleRunCompletion(opts({ deferRunCompleteLog: true }));
    result.logRunComplete?.({
      durationMs: 9_448_000,
      storiesDurationMs: 8_393_000,
      endPhaseDurationMs: 1_055_000,
      totalCost: 4.25,
      workflowPassed: true,
    });
    const data = completes()[0]?.data;
    expect(data).toMatchObject({ durationMs: 9_448_000, storiesDurationMs: 8_393_000, endPhaseDurationMs: 1_055_000 });
    expect(data).not.toHaveProperty("featureWorkflowDurationMs");
  });

  test("a failure after the line was held back still writes it once", async () => {
    const statusWriter = makeStatusWriter();
    statusWriter.setRunStatus = mock(() => {
      throw new Error("status write failed");
    });
    await expect(handleRunCompletion(opts({ deferRunCompleteLog: true, statusWriter }))).rejects.toThrow(
      "status write failed",
    );
    expect(completes()).toHaveLength(1);
  });
});

/** US-004: the cost breakdowns on the line are the aggregator's state when the line is written. */
describe("run.complete cost breakdowns (US-004)", () => {
  const snap = (totalCostUsd: number, totalErrorCostUsd = 0): CostSnapshot => ({
    ...createNoOpCostAggregator().snapshot(),
    totalCostUsd,
    totalErrorCostUsd,
  });

  /** A no-op aggregator whose stage/story splits are read from `stages()` at every call. */
  const aggregatorWith = (
    stages: () => Record<string, CostSnapshot>,
    stories: () => Record<string, CostSnapshot>,
  ): ICostAggregator => ({ ...createNoOpCostAggregator(), byStage: stages, byStory: stories });

  const completeData = (): Record<string, unknown> => {
    const entry = completes()[0];
    assertDefined(entry, "the run.complete log entry");
    assertDefined(entry.data, "the run.complete log data");
    return entry.data;
  };

  // The line's data is unknown-typed, and a snapshot reaches a sink already redacted
  // (`tokenUsageCount` is key-redacted by SECRET_KEY_PATTERN), so these read the two cost halves
  // and the keys rather than deep-comparing a whole snapshot.
  /** The keys of one split on the line, code-point sorted so the assertion is order-independent. */
  function keysOf(split: unknown): string[] {
    if (typeof split !== "object" || split === null) return [];
    return Object.keys(split).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  /** One row of a split, by key. */
  function rowOf(split: unknown, key: string): unknown {
    if (typeof split !== "object" || split === null) return undefined;
    for (const [k, row] of Object.entries(split)) if (k === key) return row;
    return undefined;
  }

  /** Σ over a split's rows of (cost + failed-dispatch spend): the money a breakdown accounts for. */
  function spentOf(split: unknown): number {
    if (typeof split !== "object" || split === null) return 0;
    return Object.values(split).reduce((sum, row) => sum + rowSpend(row), 0);
  }

  /** One row's two cost halves, read defensively. */
  function rowSpend(row: unknown): number {
    if (typeof row !== "object" || row === null) return 0;
    const cost = "totalCostUsd" in row ? row.totalCostUsd : undefined;
    const errorCost = "totalErrorCostUsd" in row ? row.totalErrorCostUsd : undefined;
    return (typeof cost === "number" ? cost : 0) + (typeof errorCost === "number" ? errorCost : 0);
  }

  test("AC-11: the deferred line reports a stage entry the aggregator gained after the call returned", async () => {
    let stages: Record<string, CostSnapshot> = { implement: snap(0.5) };
    const runtime = makeMockRuntime({
      costAggregator: aggregatorWith(
        () => stages,
        () => ({}),
      ),
    });
    const result = await handleRunCompletion(opts({ deferRunCompleteLog: true, runtime }));
    // The feature workflow runs after handleRunCompletion returns, so its review lands in the aggregator late.
    stages = { ...stages, review: snap(0.7) };
    result.logRunComplete?.(FINAL);
    expect(keysOf(completeData().costByStage)).toEqual(["implement", "review"]);
  });

  test("AC-12: the logged stage splits sum to the logged total, error spend included", async () => {
    const implement = snap(0.5, 0.25);
    const review = snap(0.7, 0.05);
    let stages: Record<string, CostSnapshot> = { implement };
    const runtime = makeMockRuntime({
      costAggregator: aggregatorWith(
        () => stages,
        () => ({}),
      ),
    });
    const result = await handleRunCompletion(opts({ deferRunCompleteLog: true, runtime }));
    stages = { implement, review };
    // What the feature workflow's late spend brings the run to.
    const total = implement.totalCostUsd + implement.totalErrorCostUsd + review.totalCostUsd + review.totalErrorCostUsd;
    result.logRunComplete?.({ ...FINAL, totalCost: total });
    expect(spentOf(completeData().costByStage)).toBeCloseTo(total, 10);
    expect(spentOf(completeData().costByStage)).toBeCloseTo(1.5, 10);
    expect(Number(completeData().totalCost)).toBeCloseTo(total, 10);
  });

  test("AC-13: without deferRunCompleteLog the line reports the split as read during the call", async () => {
    let stages: Record<string, CostSnapshot> = { implement: snap(0.5) };
    const runtime = makeMockRuntime({
      costAggregator: aggregatorWith(
        () => stages,
        () => ({}),
      ),
    });
    await handleRunCompletion(opts({ runtime }));
    stages = { ...stages, review: snap(9) };
    expect(completes()).toHaveLength(1);
    expect(keysOf(completeData().costByStage)).toEqual(["implement"]);
  });

  test("AC-14: the aggregator's run-level story key is logged as _run, and no '' row is logged", () => {
    logRunCompletion({
      options: opts(),
      prd: prd(),
      allStoryMetrics: [],
      finalCounts: countStories(prd()),
      reportedTotal: 0.2983,
      errorCostField: {},
      aggByStage: {},
      aggByStory: { "": snap(0.2983), "US-001": snap(1) },
      durationMs: 10,
      logger: getSafeLogger() ?? undefined,
    });
    const costByStory = completeData().costByStory;
    expect(keysOf(costByStory)).toEqual(["US-001", "_run"]);
    expect(rowSpend(rowOf(costByStory, "_run"))).toBeCloseTo(0.2983, 10);
    expect(rowSpend(rowOf(costByStory, "US-001"))).toBeCloseTo(1, 10);
  });
});
