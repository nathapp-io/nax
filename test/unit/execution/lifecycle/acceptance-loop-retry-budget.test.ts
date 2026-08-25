/**
 * BUG-11: `acceptance.maxRetries` means fix cycles, not "attempts before this
 * one". The retry whose count just reached the budget must still get to run
 * its own fix cycle — split out of acceptance-loop-cycle.test.ts (file-size
 * ratchet) since this is a distinct concern (the outer loop's retry-budget
 * boundary, not the fix cycle's internal configuration).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeMockAgentManager, makeMockRuntime, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { DiagnosisResult } from "@/acceptance";
import { _diagnosisDeps } from "@/execution/lifecycle/acceptance-fix";
import {
  _acceptanceFixCycleDeps,
  _acceptanceLoopDeps,
  _regenerateDeps,
  _runAcceptanceTestsOnceDeps,
  type AcceptanceLoopContext,
  runAcceptanceLoop,
} from "@/execution/lifecycle/acceptance-loop";
import type { Finding } from "@/findings";
import { addSink, initLogger, resetLogger } from "@/logger";
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
    abortSignal: new AbortController().signal,
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
    _acceptanceFixCycleDeps.runFixCycle = async <F extends Finding>() => {
      fixCycleRunCount++;
      const finding = {
        source: "test-runner",
        severity: "error",
        category: "assertion-failure",
        message: "AC-1 still failing",
        fixTarget: "test",
      } as F;
      // "max-attempts-total" — the fix cycle's own retry budget ran out without
      // resolving the finding (a valid FixCycleExitReason; "exhausted" is not).
      return { iterations: [], finalFindings: [finding], exitReason: "max-attempts-total" as const };
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

// ─── BUG-3: exhaustion must log + fire on-pause, never fall out silently ──────

describe("runAcceptanceLoop — BUG-3 exhaustion logs and fires on-pause", () => {
  let tempDir: string;
  let stubTestPath: string;
  let markerPath: string;
  let unsubscribeSink: (() => void) | undefined;
  let logMessages: string[];

  beforeEach(() => {
    tempDir = makeTempDir("nax-acceptance-loop-bug3-");
    stubTestPath = join(tempDir, ".nax-acceptance.test.ts");
    markerPath = join(tempDir, "on-pause-fired.marker");
    logMessages = [];
    resetLogger();
    initLogger({ level: "info", headless: true, useChalk: false });
    unsubscribeSink = addSink((entry) => {
      logMessages.push(entry.message);
    });
  });

  afterEach(() => {
    unsubscribeSink?.();
    resetLogger();
    cleanupTempDir(tempDir);
  });

  test("stub-regen exhaustion (maxRetries reached via the do-while's continue path) logs and pauses instead of returning silently", async () => {
    // Reproduces the do-while's dead guard: the loop's bottom condition
    // `acceptanceRetries < maxRetries` becomes false immediately after the
    // stub-regen `continue` reaches the retry budget, so the loop exits
    // without ever re-checking `if (acceptanceRetries > maxRetries)` — the
    // function falls out to the unconditional `buildResult(false, ...)`
    // after the loop with no "Max acceptance retries reached" log and no
    // `on-pause` hook fired.
    await Bun.write(stubTestPath, "expect(true).toBe(false);\n");

    const origAcceptanceSetupExecute = _regenerateDeps.acceptanceSetupExecute;
    _regenerateDeps.acceptanceSetupExecute = async () => {
      // Regeneration "succeeds" but keeps producing a stub — the retry
      // budget is what must stop the loop, not stub detection.
      await Bun.write(stubTestPath, "expect(true).toBe(false);\n");
    };

    const origImportAcceptanceStage = _runAcceptanceTestsOnceDeps.importAcceptanceStage;
    const stubbedExecute = (ctx: any) => {
      ctx.acceptanceFailures = {
        failedACs: ["AC-1"],
        findings: [],
        testOutput: "boom",
      };
      return Promise.resolve({ action: "fail" as const });
    };
    _runAcceptanceTestsOnceDeps.importAcceptanceStage = async () =>
      ({ acceptanceStage: { execute: stubbedExecute } }) as any;

    const origLoadContent = _acceptanceLoopDeps.loadAcceptanceTestContent;
    _acceptanceLoopDeps.loadAcceptanceTestContent = async () => [];

    try {
      const ctx = makeCtx();
      ctx.config = makeNaxConfig({ acceptance: { maxRetries: 1, fix: { strategy: "diagnose-first" } } });
      ctx.workdir = tempDir;
      ctx.featureDir = tempDir;
      ctx.acceptanceTestPaths = [{ testPath: stubTestPath, packageDir: tempDir }];
      ctx.hooks = {
        hooks: { "on-pause": { command: `touch ${markerPath}`, enabled: true } },
      } as AcceptanceLoopContext["hooks"];

      const result = await runAcceptanceLoop(ctx);

      expect(result.success).toBe(false);
      expect(logMessages).toContain("Max acceptance retries reached");
      expect(await Bun.file(markerPath).exists()).toBe(true);
    } finally {
      _regenerateDeps.acceptanceSetupExecute = origAcceptanceSetupExecute;
      _runAcceptanceTestsOnceDeps.importAcceptanceStage = origImportAcceptanceStage;
      _acceptanceLoopDeps.loadAcceptanceTestContent = origLoadContent;
    }
  });
});
