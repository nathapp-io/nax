/**
 * BUG-11: `acceptance.maxRetries` means fix cycles, not "attempts before this
 * one". The retry whose count just reached the budget must still get to run
 * its own fix cycle — split out of acceptance-loop-cycle.test.ts (file-size
 * ratchet) since this is a distinct concern (the outer loop's retry-budget
 * boundary, not the fix cycle's internal configuration).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DiagnosisResult } from "@/acceptance";
import type { Finding } from "@/findings";
import {
  _acceptanceFixCycleDeps,
  _acceptanceLoopDeps,
  _runAcceptanceTestsOnceDeps,
  runAcceptanceLoop,
  type AcceptanceLoopContext,
} from "../../../../src/execution/lifecycle/acceptance-loop";
import { _diagnosisDeps } from "../../../../src/execution/lifecycle/acceptance-fix";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig } from "@test/helpers";
import type { PRD } from "@/prd";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makePrd(): PRD {
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
  const config = makeNaxConfig({
    acceptance: {
      maxRetries: 3,
      fix: { strategy: "diagnose-first" },
    },
  });
  const runtime = makeMockRuntime({ config });
  return {
    config,
    prd: makePrd(),
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/workdir",
    featureDir: "/tmp/features/test",
    feature: "test-feature",
    hooks: {} as AcceptanceLoopContext["hooks"],
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 0,
    allStoryMetrics: [],
    pluginRegistry: {} as AcceptanceLoopContext["pluginRegistry"],
    statusWriter: {} as AcceptanceLoopContext["statusWriter"],
    agentManager: makeMockAgentManager(),
    sessionManager: runtime.sessionManager,
    acceptanceTestPaths: [{ testPath: "/tmp/test.ts", packageDir: "/tmp/workdir" }],
    runtime,
    abortSignal: undefined as unknown as AbortSignal,
  };
}

// ─── BUG-11: maxRetries means fix cycles — the boundary case (maxRetries:1) ───

describe("runAcceptanceLoop — BUG-11 off-by-one at maxRetries:1", () => {
  let origRunFixCycle: typeof _acceptanceFixCycleDeps.runFixCycle;

  beforeEach(() => {
    origRunFixCycle = _acceptanceFixCycleDeps.runFixCycle;
  });

  afterEach(() => {
    _acceptanceFixCycleDeps.runFixCycle = origRunFixCycle;
  });

  test("maxRetries:1 still runs one fix cycle instead of failing with zero", async () => {
    let fixCycleRan = false;
    _acceptanceFixCycleDeps.runFixCycle = async () => {
      fixCycleRan = true;
      return { iterations: [], finalFindings: [], exitReason: "resolved" };
    };

    let callCount = 0;
    const origImportAcceptanceStage = _runAcceptanceTestsOnceDeps.importAcceptanceStage;
    const stubbedExecute = (ctx: any) => {
      callCount++;
      if (callCount === 1) {
        ctx.acceptanceFailures = {
          failedACs: ["AC-1"],
          findings: [],
          testOutput: "boom",
          failedPackages: [{ testPath: "/repo/t.test.ts", packageDir: "/repo", output: "boom", failedACs: ["AC-1"] }],
        };
        return Promise.resolve({ action: "fail" as const });
      }
      // Final full validation pass (post-fix-cycle) — reports success.
      return Promise.resolve({ action: "continue" as const });
    };
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = async () =>
      ({ acceptanceStage: { execute: stubbedExecute } }) as any;

    const origLoadContent = _acceptanceLoopDeps.loadAcceptanceTestContent;
    _acceptanceLoopDeps.loadAcceptanceTestContent = async () => [];

    const origCallOp = _diagnosisDeps.callOp;
    (_diagnosisDeps as any).callOp = async () => ({
      output: { verdict: "source_bug", reasoning: "stub", confidence: 0.9 } satisfies DiagnosisResult,
      costUsd: 0,
    });

    try {
      const ctx = makeCtx();
      ctx.config = makeNaxConfig({ acceptance: { maxRetries: 1, fix: { strategy: "diagnose-first" } } });
      ctx.workdir = "/repo";
      ctx.featureDir = undefined; // skip stub guard / loadSemanticVerdicts
      ctx.acceptanceTestPaths = [{ testPath: "/repo/t.test.ts", packageDir: "/repo" }];

      const result = await runAcceptanceLoop(ctx);

      // Before the fix: acceptanceRetries(1) >= maxRetries(1) bailed out before
      // ever calling runFixCycle. After the fix: the retry whose count just
      // reached the budget still gets to run its fix cycle.
      expect(fixCycleRan).toBe(true);
      expect(result.success).toBe(true);
    } finally {
      (_diagnosisDeps as any).callOp = origCallOp;
      _runAcceptanceTestsOnceDeps.importAcceptanceStage = origImportAcceptanceStage;
      _acceptanceLoopDeps.loadAcceptanceTestContent = origLoadContent;
    }
  });

  test("maxRetries:1 still fails (without a fix cycle) once a second retry would be needed", async () => {
    // A retry that would EXCEED the budget (the second failure, with maxRetries:1)
    // must still be refused — only the boundary retry itself gets to run.
    let fixCycleRunCount = 0;
    _acceptanceFixCycleDeps.runFixCycle = async () => {
      fixCycleRunCount++;
      const finding: Finding = {
        source: "test-runner",
        severity: "error",
        category: "assertion-failure",
        message: "AC-1 still failing",
        fixTarget: "test",
      };
      return { iterations: [], finalFindings: [finding], exitReason: "exhausted" };
    };

    const origImportAcceptanceStage = _runAcceptanceTestsOnceDeps.importAcceptanceStage;
    const stubbedExecute = (ctx: any) => {
      ctx.acceptanceFailures = {
        failedACs: ["AC-1"],
        findings: [],
        testOutput: "still boom",
        failedPackages: [
          { testPath: "/repo/t.test.ts", packageDir: "/repo", output: "still boom", failedACs: ["AC-1"] },
        ],
      };
      return Promise.resolve({ action: "fail" as const });
    };
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = async () =>
      ({ acceptanceStage: { execute: stubbedExecute } }) as any;

    const origLoadContent = _acceptanceLoopDeps.loadAcceptanceTestContent;
    _acceptanceLoopDeps.loadAcceptanceTestContent = async () => [];

    const origCallOp = _diagnosisDeps.callOp;
    (_diagnosisDeps as any).callOp = async () => ({
      output: { verdict: "source_bug", reasoning: "stub", confidence: 0.9 } satisfies DiagnosisResult,
      costUsd: 0,
    });

    try {
      const ctx = makeCtx();
      ctx.config = makeNaxConfig({ acceptance: { maxRetries: 1, fix: { strategy: "diagnose-first" } } });
      ctx.workdir = "/repo";
      ctx.featureDir = undefined;
      ctx.acceptanceTestPaths = [{ testPath: "/repo/t.test.ts", packageDir: "/repo" }];

      const result = await runAcceptanceLoop(ctx);

      // Exactly one fix cycle ran (the boundary retry). The non-stub-regen path
      // always returns after its one fix-cycle + final-validation pass — the
      // do-while's bottom `while` condition is unreachable there — so a second
      // retry never gets a chance to run regardless of maxRetries.
      expect(fixCycleRunCount).toBe(1);
      expect(result.success).toBe(false);
    } finally {
      (_diagnosisDeps as any).callOp = origCallOp;
      _runAcceptanceTestsOnceDeps.importAcceptanceStage = origImportAcceptanceStage;
      _acceptanceLoopDeps.loadAcceptanceTestContent = origLoadContent;
    }
  });
});
