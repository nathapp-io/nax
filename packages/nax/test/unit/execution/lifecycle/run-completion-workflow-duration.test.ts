/**
 * nax#2491: in workflow mode the `run.complete` log line is held back until the feature workflow
 * has run, then written with the whole run's duration and the stories / feature-workflow split.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makeSessionManager,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import type { RunCompletionOptions } from "@/execution";
import { handleRunCompletion } from "@/execution";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { pipelineEventBus } from "@/pipeline";
import type { PRD, UserStory } from "@/prd";

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

  test("the deferred line carries the whole-run duration and both parts", async () => {
    const result = await handleRunCompletion(opts({ deferRunCompleteLog: true }));
    result.logRunComplete?.({
      durationMs: 9_448_000,
      storiesDurationMs: 8_393_000,
      featureWorkflowDurationMs: 1_055_000,
    });
    expect(completes()).toHaveLength(1);
    expect(completes()[0]?.data).toMatchObject({
      durationMs: 9_448_000,
      storiesDurationMs: 8_393_000,
      featureWorkflowDurationMs: 1_055_000,
    });
  });
});
