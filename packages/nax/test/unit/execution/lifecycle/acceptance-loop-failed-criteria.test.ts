import { describe, expect, test } from "bun:test";
import {
  cleanupTempDir,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makeStatusWriter,
  makeTempDir,
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
import { addSink, initLogger, resetLogger } from "@/logger";
import * as pipelineStages from "@/pipeline/stages";
import type { PipelineContext, StageResult } from "@/pipeline/types";
import type { PRD } from "@/prd";

function stubStagesModule(execute: (ctx: PipelineContext) => Promise<StageResult>) {
  return async () =>
    Object.assign({}, pipelineStages, { acceptanceStage: { ...pipelineStages.acceptanceStage, execute } });
}

function makeRetryPrd(): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [
      {
        id: "US-001",
        title: "Test story",
        description: "A test story",
        acceptanceCriteria: ["AC1", "AC2"],
        dependencies: [] as string[],
        tags: [] as string[],
        status: "passed" as const,
        passes: true,
        escalations: [],
        attempts: 0,
      },
    ],
  };
}

function makeCtx(): AcceptanceLoopContext {
  const config = makeNaxConfig({ acceptance: { maxRetries: 3, fix: { strategy: "diagnose-first" } } });
  const runtime = makeMockRuntime({ config });
  return {
    config,
    prd: makeRetryPrd(),
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/workdir",
    featureDir: "/tmp/features/test",
    feature: "test-feature",
    hooks: { hooks: {} },
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 0,
    allStoryMetrics: [],
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    agentManager: makeMockAgentManager(),
    sessionManager: runtime.sessionManager,
    acceptanceTestPaths: [{ testPath: "/tmp/test.ts", packageDir: "/tmp/workdir" }],
    runtime,
    abortSignal: new AbortController().signal,
  };
}

describe("runAcceptanceLoop failed-criteria diagnosis (US-001)", () => {
  test("US-001 AC21-22: forwards per-package failed criteria and logs diagnosis path", async () => {
    const tempDir = makeTempDir("nax-failed-criteria-loop-");
    const originalReadFile = _failedCriteriaDeps.readFile;
    const originalCallOp = _diagnosisDeps.callOp;
    const originalRunFixCycle = _acceptanceFixCycleDeps.runFixCycle;
    const originalImport = _runAcceptanceTestsOnceDeps.importAcceptanceStage;
    const originalLoadContent = _acceptanceLoopDeps.loadAcceptanceTestContent;
    const calls: Array<{ input: { failedCriteria?: unknown } }> = [];
    const logs: Array<{ message: string; data?: Record<string, unknown> }> = [];
    resetLogger();
    initLogger({ level: "info", headless: true, useChalk: false });
    const unsubscribe = addSink((entry) => logs.push({ message: entry.message, data: entry.data }));
    try {
      _failedCriteriaDeps.readFile = async () =>
        JSON.stringify([
          { acId: "AC-1", original: "o1", refined: "r1", storyId: "US-001" },
          { acId: "AC-2", original: "o2", refined: "r2", storyId: "US-002" },
          { acId: "AC-3", original: "o3", refined: "o3", storyId: "US-002" },
        ]);
      let runs = 0;
      _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStagesModule(async (ctx) => {
        runs++;
        if (runs > 1) return { action: "continue" };
        ctx.acceptanceFailures = {
          failedACs: ["AC-2"],
          findings: [],
          testOutput: "failure",
          failedPackages: [
            { testPath: "/repo/t.test.ts", packageDir: "/repo", output: "failure", failedACs: ["AC-2"] },
          ],
        };
        return { action: "fail", reason: "acceptance failure" };
      });
      _acceptanceLoopDeps.loadAcceptanceTestContent = async () => [];
      _acceptanceFixCycleDeps.runFixCycle = async () => ({ iterations: [], finalFindings: [], exitReason: "resolved" });
      _diagnosisDeps.callOp = async (_ctx, _op, input) => {
        calls.push({ input });
        return { verdict: "source_bug", reasoning: "diagnosed", confidence: 0.8 };
      };
      const ctx = makeCtx();
      ctx.config = makeNaxConfig({ acceptance: { maxRetries: 1, fix: { strategy: "diagnose-first" } } });
      ctx.prd = {
        ...makeRetryPrd(),
        userStories: [
          { ...makeRetryPrd().userStories[0], id: "US-001", acceptanceCriteria: ["one"] },
          { ...makeRetryPrd().userStories[0], id: "US-002", acceptanceCriteria: ["two", "three"] },
        ],
      };
      ctx.workdir = "/repo";
      ctx.featureDir = tempDir;
      ctx.acceptanceTestPaths = [{ testPath: "/repo/t.test.ts", packageDir: "/repo" }];
      await runAcceptanceLoop(ctx);
      const entry = logs.find((log) => log.message === "Diagnosis resolved");
      expect({
        failedCriteria: calls[0].input.failedCriteria,
        diagnosisLog: { path: entry?.data?.path, failedACs: entry?.data?.failedACs },
      }).toEqual({
        failedCriteria: [{ acId: "AC-2", storyId: "US-002", original: "o2", refined: "r2" }],
        diagnosisLog: { path: "llm", failedACs: ["AC-2"] },
      });
    } finally {
      unsubscribe();
      resetLogger();
      _failedCriteriaDeps.readFile = originalReadFile;
      _diagnosisDeps.callOp = originalCallOp;
      _acceptanceFixCycleDeps.runFixCycle = originalRunFixCycle;
      _runAcceptanceTestsOnceDeps.importAcceptanceStage = originalImport;
      _acceptanceLoopDeps.loadAcceptanceTestContent = originalLoadContent;
      cleanupTempDir(tempDir);
    }
  });
});
