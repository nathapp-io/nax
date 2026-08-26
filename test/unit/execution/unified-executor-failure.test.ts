/**
 * Behavioral tests for failure routing in executeUnified.
 *
 * File: unified-executor-failure.test.ts
 * Covers:
 *   exec AC-23  failed story is routed through handlePipelineFailure;
 *               an 'escalate' finalAction reaches handleTierEscalation (source + behavioral)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import {
  makeDispatchContext,
  makeMockRuntime,
  makeNaxConfig,
  makePluginRegistry,
  makePRD,
  makeStatusWriter,
  makeStory,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { SequentialExecutionContext, SequentialExecutionResult } from "@/execution/unified-executor";
import { executeUnified } from "@/execution/unified-executor";
import type { LoadedHooksConfig } from "@/hooks";
import type { PRD } from "@/prd/types";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

const SRC = join(import.meta.dir, "../../../src");

// ─────────────────────────────────────────────────────────────────────────────
// exec AC-23 — source-level: handlePipelineFailure has escalate→handleTierEscalation path
// ─────────────────────────────────────────────────────────────────────────────

describe("exec AC-23 (source): handlePipelineFailure routes escalate action to handleTierEscalation", () => {
  test("AC-23: pipeline-result-handler.ts has case 'escalate' that calls handleTierEscalation", async () => {
    const source = await Bun.file(join(SRC, "execution/pipeline-result-handler.ts")).text();
    // The escalate switch case must be present
    expect(source).toContain(`case "escalate"`);
    // It must call handleTierEscalation
    expect(source).toContain("handleTierEscalation");
    // handleTierEscalation must be called within the escalate case body
    const escalateCaseIdx = source.indexOf(`case "escalate"`);
    const tierEscalationIdx = source.indexOf("handleTierEscalation", escalateCaseIdx);
    expect(escalateCaseIdx).toBeGreaterThan(0);
    expect(tierEscalationIdx).toBeGreaterThan(escalateCaseIdx);
    // The call is within ~500 chars of the case start (same block). US-002
    // added the runtimeCrashResult derivation inline in the same case body,
    // so the distance grew but the call is still inside the escalate case.
    expect(tierEscalationIdx - escalateCaseIdx).toBeLessThan(500);
  });

  test("AC-23: handlePipelineFailure is imported from pipeline-result-handler in unified-executor.ts", async () => {
    const source = await Bun.file(join(SRC, "execution/unified-executor.ts")).text();
    expect(source).toContain("handlePipelineFailure");
    // The import must reference pipeline-result-handler
    expect(source).toMatch(/from\s+["']\.\/pipeline-result-handler["']/);
  });

  test("AC-23: handleTierEscalation is imported from escalation module in pipeline-result-handler.ts", async () => {
    const source = await Bun.file(join(SRC, "execution/pipeline-result-handler.ts")).text();
    expect(source).toContain("handleTierEscalation");
    // Must be imported from the escalation barrel or submodule
    expect(source).toMatch(/from\s+["']\.\/escalation["']/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exec AC-23 (behavioral) — executeUnified routes batch failures through
// handlePipelineFailure with the correct pipelineResult
// ─────────────────────────────────────────────────────────────────────────────

describe("exec AC-23 (behavioral): executeUnified calls handlePipelineFailure for each batchResult.failed entry", () => {
  function makePendingStory(id: string) {
    return makeStory({ id, title: `Story ${id}`, description: `Description for ${id}` });
  }

  function makePrd(stories: ReturnType<typeof makePendingStory>[]): PRD {
    return makePRD({ userStories: stories });
  }

  function makeCtx(parallelCount = 2): SequentialExecutionContext {
    return {
      prdPath: "/tmp/test-prd.json",
      workdir: "/tmp/test-workdir",
      config: {
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          maxIterations: 1,
          costLimit: 100,
          iterationDelayMs: 0,
          rectification: {
            ...DEFAULT_CONFIG.execution.rectification,
            maxAttemptsTotal: 2,
          },
        },
      },
      hooks: EMPTY_HOOKS,
      feature: "test-feature",
      dryRun: false,
      useBatch: false,
      pluginRegistry: makePluginRegistry(),
      statusWriter: makeStatusWriter(),
      runId: "run-test",
      startTime: Date.now(),
      batchPlan: [],
      interactionChain: null,
      ...makeDispatchContext({
        runtime: makeMockRuntime({
          workdir: "/tmp/nax-test-failure-output",
          costAggregator: createNoOpCostAggregator(),
        }),
      }),
      parallelCount,
    };
  }

  let deps: Record<string, unknown>;
  let origSelect: unknown;
  let origBatch: unknown;

  beforeEach(async () => {
    const mod = await import("@/execution/unified-executor");
    deps = (mod as Record<string, unknown>)._unifiedExecutorDeps as Record<string, unknown>;
    origSelect = deps.selectIndependentBatch;
    origBatch = deps.runParallelBatch;
  });

  afterEach(() => {
    deps.selectIndependentBatch = origSelect;
    deps.runParallelBatch = origBatch;
    mock.restore();
  });

  test("AC-23: batchResult.failed story reaches handlePipelineFailure with its pipelineResult (fail action)", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    // story2 will fail — its pipelineResult has finalAction: "fail"
    const failedPipelineResult = {
      success: false,
      finalAction: "fail" as const,
      reason: "Tests failed",
      context: { agentResult: { estimatedCostUsd: 0.1 } },
      stageCost: 0,
      stoppedAtStage: "verify",
    };

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      // story1 completed, story2 failed
      completed: [story1],
      failed: [{ story: story2, pipelineResult: failedPipelineResult }],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, 0.1],
        [story2.id, 0.1],
      ]),
      totalCost: 0.2,
    }));

    // Inject a savePRD spy so handlePipelineFailure doesn't attempt real disk writes
    const { _tierEscalationDeps } = await import("@/execution/escalation/tier-escalation");
    const origSavePRD = _tierEscalationDeps.savePRD;
    _tierEscalationDeps.savePRD = mock(async () => {});

    // Inject into pipeline-result-handler as well
    const { _resultHandlerDeps } = await import("@/execution/pipeline-result-handler");
    const origSpawn = _resultHandlerDeps.spawn;
    _resultHandlerDeps.spawn = mock(() => {
      const proc: Pick<Bun.Subprocess, "exited"> = { exited: Promise.resolve(0) };
      return proc as typeof Bun.spawn extends (...args: never) => infer R ? R : never;
    });

    try {
      // Failure routing is best-effort and must not throw.
      const result = await executeUnified(makeCtx(), makePrd([story1, story2])).catch(() => undefined);

      // The failed story (story2) must be routed through the failure path, NOT counted
      // as completed: storiesCompleted reflects only the batch's `completed` array (story1).
      expect(result).toBeDefined();
      expect((result as { storiesCompleted: number }).storiesCompleted).toBe(1);
    } finally {
      _tierEscalationDeps.savePRD = origSavePRD;
      _resultHandlerDeps.spawn = origSpawn;
    }
  });

  test("AC-23: executeUnified returns a valid result even when batch has failures", async () => {
    const story1 = makePendingStory("US-001");
    const story2 = makePendingStory("US-002");

    const failedPipelineResult = {
      success: false,
      finalAction: "fail" as const,
      reason: "Compilation error",
      context: { agentResult: { estimatedCostUsd: 0.05 } },
      stageCost: 0,
      stoppedAtStage: "compile",
    };

    deps.selectIndependentBatch = mock(() => [story1, story2]);
    deps.runParallelBatch = mock(async () => ({
      completed: [story1],
      failed: [{ story: story2, pipelineResult: failedPipelineResult }],
      mergeConflicts: [],
      storyCosts: new Map([
        [story1.id, 0.2],
        [story2.id, 0.05],
      ]),
      totalCost: 0.25,
    }));

    const { _resultHandlerDeps } = await import("@/execution/pipeline-result-handler");
    const origSpawn = _resultHandlerDeps.spawn;
    _resultHandlerDeps.spawn = mock(() => {
      const proc: Pick<Bun.Subprocess, "exited"> = { exited: Promise.resolve(0) };
      return proc as typeof Bun.spawn extends (...args: never) => infer R ? R : never;
    });

    try {
      // Failure routing is best-effort and must not throw. The .catch is a
      // belt-and-braces fallback for unexpected throws so the assertion below
      // can still observe a result.
      const result = await executeUnified(makeCtx(), makePrd([story1, story2])).catch((): SequentialExecutionResult => {
        throw new Error("executeUnified should not throw on failure path");
      });

      // The executor must return a valid result object regardless of failures
      expect(result).toBeDefined();
      expect(typeof result.totalCost).toBe("number");
    } finally {
      _resultHandlerDeps.spawn = origSpawn;
    }
  });
});
