import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makeStatusWriter,
  makeStory,
  opSelector,
} from "@test/helpers";
import { _failedCriteriaDeps } from "@/acceptance/failed-criteria";
import { _diagnosisDeps } from "@/execution/lifecycle/acceptance-fix";
import {
  _acceptanceFixCycleDeps,
  _acceptanceLoopDeps,
  _runAcceptanceTestsOnceDeps,
  type AcceptanceLoopContext,
  runAcceptanceLoop,
} from "@/execution/lifecycle/acceptance-loop";
import { _acceptanceAttemptDeps } from "@/execution/lifecycle/acceptance-summary";
import type { Finding, FixCycleContext } from "@/findings";
import { _cycleDeps } from "@/findings/cycle";
import type { Iteration } from "@/findings/cycle-types";
import { addSink, initLogger, resetLogger } from "@/logger";
import { acceptanceFixSourceOp } from "@/operations";
import type { Operation } from "@/operations/types";
import * as pipelineStages from "@/pipeline/stages";
import type { PipelineContext, StageResult } from "@/pipeline/types";

function stubStages(execute: (ctx: PipelineContext) => Promise<StageResult>) {
  return async () =>
    Object.assign({}, pipelineStages, { acceptanceStage: { ...pipelineStages.acceptanceStage, execute } });
}

function context(maxRetries = 1): AcceptanceLoopContext {
  const config = makeNaxConfig({ acceptance: { maxRetries, fix: { strategy: "diagnose-first" } } });
  const runtime = makeMockRuntime({ config });
  return {
    config,
    prd: {
      project: "p",
      feature: "f",
      branchName: "b",
      createdAt: "",
      updatedAt: "",
      userStories: [makeStory({ id: "US-001", acceptanceCriteria: ["one", "two"] })],
    },
    prdPath: "/repo/prd.json",
    workdir: "/repo",
    featureDir: undefined,
    feature: "f",
    hooks: { hooks: {} },
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 0,
    allStoryMetrics: [],
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    agentManager: makeMockAgentManager(),
    sessionManager: runtime.sessionManager,
    runtime,
    abortSignal: new AbortController().signal,
  };
}

let originalImport: typeof _runAcceptanceTestsOnceDeps.importAcceptanceStage;
let originalFixCycle: typeof _acceptanceFixCycleDeps.runFixCycle;
let originalDiagnosis: typeof _diagnosisDeps.callOp;
let originalLoad: typeof _acceptanceLoopDeps.loadAcceptanceTestContent;
let originalCaptureRef: typeof _acceptanceAttemptDeps.captureGitRef;
let originalCaptureChanges: typeof _acceptanceAttemptDeps.captureWorkingTreeChanges;
let originalCycleCallOp: typeof _cycleDeps.callOp;
let originalCriteriaRead: typeof _failedCriteriaDeps.readFile;
let unsubscribe: (() => void) | undefined;
let entries: Array<{ message: string; data?: Record<string, unknown> }>;

beforeEach(() => {
  originalImport = _runAcceptanceTestsOnceDeps.importAcceptanceStage;
  originalFixCycle = _acceptanceFixCycleDeps.runFixCycle;
  originalDiagnosis = _diagnosisDeps.callOp;
  originalLoad = _acceptanceLoopDeps.loadAcceptanceTestContent;
  originalCaptureRef = _acceptanceAttemptDeps.captureGitRef;
  originalCaptureChanges = _acceptanceAttemptDeps.captureWorkingTreeChanges;
  originalCycleCallOp = _cycleDeps.callOp;
  originalCriteriaRead = _failedCriteriaDeps.readFile;
  entries = [];
  resetLogger();
  initLogger({ level: "info", headless: true, useChalk: false });
  unsubscribe = addSink((entry) => entries.push({ message: entry.message, data: entry.data }));
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  _runAcceptanceTestsOnceDeps.importAcceptanceStage = originalImport;
  _acceptanceFixCycleDeps.runFixCycle = originalFixCycle;
  _diagnosisDeps.callOp = originalDiagnosis;
  _acceptanceLoopDeps.loadAcceptanceTestContent = originalLoad;
  _acceptanceAttemptDeps.captureGitRef = originalCaptureRef;
  _acceptanceAttemptDeps.captureWorkingTreeChanges = originalCaptureChanges;
  _cycleDeps.callOp = originalCycleCallOp;
  _failedCriteriaDeps.readFile = originalCriteriaRead;
  resetLogger();
});

function summaries() {
  return entries.filter((entry) => entry.message === "acceptance.summary");
}

function sourceFixIteration<F extends Finding = Finding>(unresolved?: string): Iteration<F> {
  return {
    iterationNum: 1,
    findingsBefore: [],
    findingsAfter: [],
    outcome: "unchanged",
    startedAt: "",
    finishedAt: "",
    fixesApplied: [
      {
        strategyName: "acceptance-source-fix",
        op: "acceptance-fix-source",
        targetFiles: ["src/a.ts", "test/a.test.ts"],
        summary: "fixed",
        ...(unresolved ? { unresolved } : {}),
      },
    ],
  };
}

describe("runAcceptanceLoop acceptance.summary (US-002)", () => {
  async function runFixAttempt(
    verdict: "source_bug" | "test_bug",
    baseRef: string | undefined,
    changed: string[],
    options: { failedAC?: string; withRefinedCriteria?: boolean } = {},
  ) {
    const calls: Array<{ opName: string; input: unknown }> = [];
    let capturedRef: string | undefined = "not-called";
    _acceptanceAttemptDeps.captureGitRef = async () => baseRef;
    _acceptanceAttemptDeps.captureWorkingTreeChanges = async (_dir, ref) => {
      capturedRef = ref;
      return changed;
    };
    _diagnosisDeps.callOp = async () => ({ verdict, reasoning: "diagnosed", confidence: 1, findings: [] });
    if (options.withRefinedCriteria) {
      _failedCriteriaDeps.readFile = async () =>
        JSON.stringify([
          { acId: "AC-1", original: "o1", refined: "r1", storyId: "US-001" },
          { acId: "AC-2", original: "o2", refined: "r2", storyId: "US-002" },
          { acId: "AC-3", original: "o3", refined: "o3", storyId: "US-002" },
        ]);
    }
    _cycleDeps.callOp = async <I, O, C>(cycleCtx: FixCycleContext, op: Operation<I, O, C>, input: I): Promise<O> => {
      calls.push({ opName: op.name, input });
      if (op.kind !== "run") throw new Error("expected acceptance run operation");
      return op.parse("fixed", input, {
        packageView: cycleCtx.packageView,
        config: cycleCtx.packageView.select(opSelector(op.config)),
      });
    };
    let run = 0;
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStages(async (ctx) => {
      run++;
      if (run > 1) return { action: "continue" };
      ctx.acceptanceFailures = {
        failedACs: [options.failedAC ?? "AC-1"],
        findings: [],
        testOutput: "failed",
        failedPackages: [
          {
            testPath: "/repo/acceptance.test.ts",
            packageDir: "/repo",
            output: "failed",
            failedACs: [options.failedAC ?? "AC-1"],
          },
        ],
      };
      return { action: "fail", reason: "failed" };
    });
    const ctx = context();
    if (options.withRefinedCriteria) {
      ctx.prd.userStories = [
        makeStory({ id: "US-001", acceptanceCriteria: ["one"] }),
        makeStory({ id: "US-002", acceptanceCriteria: ["two", "three"] }),
      ];
      ctx.featureDir = "/repo/.nax/features/f";
    }
    ctx.acceptanceTestPaths = [{ testPath: "/repo/acceptance.test.ts", packageDir: "/repo" }];
    await runAcceptanceLoop(ctx);
    return { calls, capturedRef };
  }

  test("AC6: runAcceptanceLoop dispatches source-fix with the resolved failed criterion", async () => {
    const { calls } = await runFixAttempt("source_bug", "abc", [], {
      failedAC: "AC-2",
      withRefinedCriteria: true,
    });
    const sourceDispatch = calls.find((call) => call.opName === acceptanceFixSourceOp.name);
    expect(sourceDispatch?.input).toMatchObject({
      failedCriteria: [{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }],
    });
  });

  test("AC7: a source-fix loop iteration logs changed files as fixTargetFiles", async () => {
    await runFixAttempt("source_bug", "abc", ["src/a.ts", "test/a.test.ts"]);
    const completed = entries.find((entry) => entry.message === "iteration completed");
    expect(completed?.data?.fixTargetFiles).toEqual(["src/a.ts", "test/a.test.ts"]);
  });

  test("AC8: a test-fix loop iteration logs no target files when its ref is unavailable", async () => {
    const { capturedRef } = await runFixAttempt("test_bug", undefined, []);
    const completed = entries.find((entry) => entry.message === "iteration completed");
    expect(completed?.data?.fixTargetFiles).toEqual([]);
    expect(capturedRef).toBeUndefined();
  });

  test("AC10: an LLM source diagnosis and changed files are reflected in the aggregate summary", async () => {
    _acceptanceFixCycleDeps.runFixCycle = async () => ({
      iterations: [sourceFixIteration()],
      finalFindings: [],
      exitReason: "resolved",
    });
    _diagnosisDeps.callOp = async () => ({
      verdict: "source_bug",
      reasoning: "source defect",
      confidence: 1,
      findings: [],
    });
    let run = 0;
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStages(async (ctx) => {
      run++;
      if (run > 1) return { action: "continue" };
      ctx.acceptanceFailures = { failedACs: ["AC-1"], findings: [], testOutput: "failed" };
      return { action: "fail", reason: "failed" };
    });
    await runAcceptanceLoop(context());
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].data).toMatchObject({
      diagnoses: { byPath: { llm: 1 } },
      sourceFixAttempts: 1,
      sourceFixFiles: { production: 1, test: 1 },
    });
  });

  test("AC11: an unresolved source-fix attempt is counted when the final acceptance check fails", async () => {
    _acceptanceFixCycleDeps.runFixCycle = async () => ({
      iterations: [sourceFixIteration("AC-2 — not stated")],
      finalFindings: [],
      exitReason: "agent-gave-up",
    });
    _diagnosisDeps.callOp = async () => ({
      verdict: "source_bug",
      reasoning: "source defect",
      confidence: 1,
      findings: [],
    });
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStages(async (ctx) => {
      ctx.acceptanceFailures = { failedACs: ["AC-1"], findings: [], testOutput: "failed" };
      return { action: "fail", reason: "failed" };
    });
    await runAcceptanceLoop(context());
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].data).toMatchObject({ outcome: "failed", sourceFixUnresolved: 1 });
  });

  test("AC9: passing on the first acceptance run emits one passed summary with no source fixes", async () => {
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStages(async () => ({ action: "continue" }));
    await runAcceptanceLoop(context());
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].data).toMatchObject({
      outcome: "passed",
      sourceFixAttempts: 0,
      diagnoses: { byVerdict: { source_bug: 0 } },
    });
  });

  test("AC13: missing diagnosis runtime exit emits one failed summary", async () => {
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStages(async (ctx) => {
      ctx.acceptanceFailures = { failedACs: ["AC-1"], findings: [], testOutput: "failed" };
      return { action: "fail", reason: "failed" };
    });
    const ctx = context();
    Reflect.set(ctx, "runtime", undefined);
    await runAcceptanceLoop(ctx);
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].data?.outcome).toBe("failed");
  });

  test("AC14: failure without specific failed criteria emits one failed summary", async () => {
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStages(async (ctx) => {
      ctx.acceptanceFailures = { failedACs: [], findings: [], testOutput: "failed" };
      return { action: "fail", reason: "failed" };
    });
    await runAcceptanceLoop(context());
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].data?.outcome).toBe("failed");
  });

  test("AC12: summary counts each in-scope story by its test strategy", async () => {
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStages(async () => ({ action: "continue" }));
    const ctx = context();
    ctx.prd.userStories = [
      makeStory({ id: "US-001", routing: { complexity: "simple", reasoning: "test", testStrategy: "tdd-simple" } }),
      makeStory({ id: "US-002", routing: { complexity: "simple", reasoning: "test", testStrategy: "tdd-simple" } }),
      makeStory({ id: "US-003", routing: { complexity: "simple", reasoning: "test", testStrategy: "no-test" } }),
    ];
    await runAcceptanceLoop(ctx);
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].data?.storyStrategies).toEqual({ "tdd-simple": 2, "no-test": 1 });
  });

  test("AC15: zero retries emits one failed summary with the returned retry count", async () => {
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStages(async (ctx) => {
      ctx.acceptanceFailures = { failedACs: ["AC-1"], findings: [], testOutput: "failed" };
      return { action: "fail", reason: "failed" };
    });
    const result = await runAcceptanceLoop(context(0));
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0].data).toMatchObject({ outcome: "failed", retries: result.retries ?? 0 });
  });
});
