/**
 * US-005 AC4 — a stale `semantic-verdicts/<story>.json` file on disk must not
 * change diagnosis.
 *
 * The writer that produced these files is gone (#1084) and the loader that read
 * them was deleted with it (US-005), so the acceptance loop must reach the LLM
 * diagnosis through `_diagnosisDeps.callOp` even when a stale file claims every
 * AC passed. These tests drive the real `runAcceptanceLoop` over a temp feature
 * directory containing such a file, asserting on the dispatch that leaves the loop
 * (the `acceptanceDiagnoseOp` call) and on the verdict the fix cycle receives.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makeStatusWriter,
  makeTempDir,
} from "@test/helpers";
import { _diagnosisDeps } from "@/execution/lifecycle/acceptance-fix";
import {
  _acceptanceFixCycleDeps,
  _acceptanceLoopDeps,
  _runAcceptanceTestsOnceDeps,
  type AcceptanceLoopContext,
  runAcceptanceLoop,
} from "@/execution/lifecycle/acceptance-loop";
import { acceptanceDiagnoseOp } from "@/operations";
import * as pipelineStages from "@/pipeline/stages";
import type { PipelineContext, StageResult } from "@/pipeline/types";
import type { PRD } from "@/prd";

// ─── Harness ─────────────────────────────────────────────────────────────────

/** Stages-module namespace rebuilt with a stubbed acceptanceStage — no mock.module(). */
function stubStagesModule(execute: (ctx: PipelineContext) => Promise<StageResult>) {
  return async () =>
    Object.assign({}, pipelineStages, { acceptanceStage: { ...pipelineStages.acceptanceStage, execute } });
}

function makePrdWithTenACs(): PRD {
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
        acceptanceCriteria: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9", "AC-10"],
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

function makeCtx(featureDir: string): AcceptanceLoopContext {
  const config = makeNaxConfig({ acceptance: { maxRetries: 3, fix: { strategy: "diagnose-first" } } });
  const runtime = makeMockRuntime({ config });
  return {
    config,
    prd: makePrdWithTenACs(),
    prdPath: "/tmp/prd.json",
    workdir: featureDir,
    featureDir,
    feature: "test-feature",
    hooks: { hooks: {} },
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 0,
    allStoryMetrics: [],
    pluginRegistry: makePluginRegistry(),
    statusWriter: makeStatusWriter(),
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    acceptanceTestPaths: [{ testPath: join(featureDir, ".nax-acceptance.test.ts"), packageDir: featureDir }],
    runtime,
    abortSignal: new AbortController().signal,
  };
}

interface Scenario {
  tempDir: string;
  /** Every `_diagnosisDeps.callOp` dispatch, in order. */
  callOpCalls: Array<{ op: unknown; input: { testOutput?: string } }>;
  /** The verdict each fix cycle was driven by, in order. */
  fixCycleVerdicts: Array<string | undefined>;
  result: Awaited<ReturnType<typeof runAcceptanceLoop>>;
}

const tempDirs: string[] = [];

/**
 * Run the acceptance loop once against a feature dir, with 1 of 10 ACs failing.
 * `verdictOnDisk` seeds `semantic-verdicts/US-001.json`; `undefined` leaves the dir bare.
 */
async function runScenario(verdictOnDisk: { passed: boolean } | undefined): Promise<Scenario> {
  const tempDir = makeTempDir("nax-stale-verdict-");
  tempDirs.push(tempDir);

  if (verdictOnDisk) {
    const verdictPath = join(tempDir, "semantic-verdicts", "US-001.json");
    await Bun.write(
      verdictPath,
      JSON.stringify(
        {
          storyId: "US-001",
          passed: verdictOnDisk.passed,
          timestamp: "2026-01-01T00:00:00.000Z",
          acCount: 9,
          findings: [],
        },
        null,
        2,
      ),
    );
  }

  const callOpCalls: Scenario["callOpCalls"] = [];
  const fixCycleVerdicts: Scenario["fixCycleVerdicts"] = [];

  // Acceptance stage: first pass fails 1 of 10 ACs; the post-fix validation passes.
  let callCount = 0;
  const stubExecute = async (ctx: PipelineContext): Promise<StageResult> => {
    callCount++;
    if (callCount === 1) {
      ctx.acceptanceFailures = {
        failedACs: ["AC-1"],
        findings: [],
        testOutput: "AC-1 failed",
        failedPackages: [
          {
            testPath: join(tempDir, ".nax-acceptance.test.ts"),
            packageDir: tempDir,
            output: "AC-1 failed",
            failedACs: ["AC-1"],
          },
        ],
      };
      return { action: "fail", reason: "acceptance tests failed" };
    }
    return { action: "continue" };
  };
  _runAcceptanceTestsOnceDeps.importAcceptanceStage = stubStagesModule(stubExecute);

  _acceptanceFixCycleDeps.runFixCycle = async (cycle) => {
    fixCycleVerdicts.push(cycle.verdict);
    return { iterations: [], finalFindings: [], exitReason: "resolved" };
  };

  _acceptanceLoopDeps.loadAcceptanceTestContent = async () => [];

  // The LLM diagnosis seam — the only thing that proves diagnosis was dispatched.
  _diagnosisDeps.callOp = async (_ctx, op, input) => {
    callOpCalls.push({ op, input });
    return { verdict: "source_bug", reasoning: "LLM diagnosis", confidence: 0.8 };
  };

  const result = await runAcceptanceLoop(makeCtx(tempDir));
  return { tempDir, callOpCalls, fixCycleVerdicts, result };
}

let savedDeps: {
  importAcceptanceStage: typeof _runAcceptanceTestsOnceDeps.importAcceptanceStage;
  runFixCycle: typeof _acceptanceFixCycleDeps.runFixCycle;
  loadAcceptanceTestContent: typeof _acceptanceLoopDeps.loadAcceptanceTestContent;
  callOp: typeof _diagnosisDeps.callOp;
};

beforeEach(() => {
  savedDeps = {
    importAcceptanceStage: _runAcceptanceTestsOnceDeps.importAcceptanceStage,
    runFixCycle: _acceptanceFixCycleDeps.runFixCycle,
    loadAcceptanceTestContent: _acceptanceLoopDeps.loadAcceptanceTestContent,
    callOp: _diagnosisDeps.callOp,
  };
});

afterEach(() => {
  _runAcceptanceTestsOnceDeps.importAcceptanceStage = savedDeps.importAcceptanceStage;
  _acceptanceFixCycleDeps.runFixCycle = savedDeps.runFixCycle;
  _acceptanceLoopDeps.loadAcceptanceTestContent = savedDeps.loadAcceptanceTestContent;
  _diagnosisDeps.callOp = savedDeps.callOp;
  for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
});

// ─── US-005 AC4 ──────────────────────────────────────────────────────────────

describe("runAcceptanceLoop — stale semantic-verdict files (US-005 AC4)", () => {
  test("US-005 AC4: dispatches LLM diagnosis exactly once when a stale passed:true verdict file is present", async () => {
    const scenario = await runScenario({ passed: true });

    expect(scenario.callOpCalls).toHaveLength(1);
    expect(scenario.callOpCalls[0].op).toBe(acceptanceDiagnoseOp);
    expect(scenario.callOpCalls[0].input.testOutput).toBe("AC-1 failed");
    expect(scenario.result.success).toBe(true);
  });

  test("US-005 AC4: does not short-circuit to test_bug without a diagnosis call when a stale passed:true verdict file is present", async () => {
    const scenario = await runScenario({ passed: true });

    // The fix cycle is driven by the LLM's verdict ("source_bug"), never by the
    // verdict-free semantic fast path, which would have reported "test_bug".
    expect(scenario.fixCycleVerdicts).toEqual(["source_bug"]);
  });

  test("US-005 AC4: a stale passed:false verdict file also reaches the diagnosis op", async () => {
    const scenario = await runScenario({ passed: false });

    expect(scenario.callOpCalls).toHaveLength(1);
    expect(scenario.fixCycleVerdicts).toEqual(["source_bug"]);
  });

  test("US-005 AC4: a feature dir with no verdict files behaves identically", async () => {
    const scenario = await runScenario(undefined);

    expect(scenario.callOpCalls).toHaveLength(1);
    expect(scenario.fixCycleVerdicts).toEqual(["source_bug"]);
  });
});
