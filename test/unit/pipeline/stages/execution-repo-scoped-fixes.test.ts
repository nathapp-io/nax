/**
 * executionStage.execute — recordRepoScopedFixes wiring (US-002)
 *
 * Mirrors src/pipeline/stages/execution.ts. Verifies that when plan.run()
 * resolves, the stage calls _executionDeps.recordRepoScopedFixes with
 * ctx.story and the plan result's repoScopedFixes before applyPostRunInspection.
 */

import { describe, expect, it } from "bun:test";
import { makeAgentAdapter, makeNaxConfig, makeTestContext, makeTestStory, withExecutionDeps } from "@test/helpers";
import { NaxError } from "@/errors";
import type { RepoScopedFixRecord } from "@/execution";
import type { PostRunInspectionResult } from "@/execution/post-run";
import type { StoryOrchestratorResult } from "@/execution/story-orchestrator";
import { ExecutionPlan } from "@/execution/story-orchestrator";
import type { CallContext } from "@/operations";
import { executionStage } from "@/pipeline/stages/execution";
import type { PipelineContext, StageResult } from "@/pipeline/types";

interface PlanResultOptions {
  readonly success?: boolean;
  readonly repoScopedFixes?: readonly RepoScopedFixRecord[];
}

function planResultWith(opts: PlanResultOptions): StoryOrchestratorResult {
  const result: StoryOrchestratorResult = {
    success: opts.success ?? true,
    phaseCosts: {},
    totalCostUsd: 0,
    durationMs: 0,
    phaseOutputs: {},
    repoScopedFixes: opts.repoScopedFixes,
  };
  return result;
}

const SAMPLE_RECORD: RepoScopedFixRecord = {
  triggeringTests: ["test/legacy/auth.spec.ts::redirects to login"],
  filesChanged: ["src/legacy/auth.ts"],
  findingsCleared: true,
};

const baseOverrides = {
  getAgent: () => makeAgentAdapter({ name: "claude" }),
  validateAgentForTier: () => true,
  captureGitRef: async () => "HEAD",
  getUntrackedPaths: async () => [],
  assemblePlanInputsFromCtx: async (ctx: PipelineContext) => ({ story: ctx.story, config: ctx.config }),
} as const;

describe("executionStage.execute — recordRepoScopedFixes wiring (US-002)", () => {
  const cfg = makeNaxConfig();

  function makeCtx(): PipelineContext {
    return makeTestContext({
      story: makeTestStory({ id: "US-recscope-01", title: "Repo-scoped record test" }),
      config: cfg,
      workdir: "/tmp/nax-recscope-test",
      routing: {
        modelTier: "fast",
        testStrategy: "test-after",
        agent: "claude",
        complexity: "simple",
        reasoning: "",
      },
      packageView: { select: () => cfg } as unknown as PipelineContext["packageView"], // test-ratchet-allow: as-unknown-as
      ...({
        runtime: {
          dispatchEvents: { onDispatch: () => () => {} },
          signal: undefined,
          packages: undefined,
          onPidSpawned: undefined,
        },
      } as unknown as Partial<PipelineContext>), // test-ratchet-allow: as-unknown-as
    });
  }

  function spyRecord(
    planRun: () => Promise<StoryOrchestratorResult>,
    onRecord?: (s: unknown, r: unknown) => void,
    onInspect?: (s: unknown, p: unknown) => void,
  ): () => void {
    const recordSpy = (story: unknown, records: unknown) => {
      onRecord?.(story, records);
    };
    const inspectSpy = async (
      ctx: PipelineContext,
      planResult: StoryOrchestratorResult,
    ): Promise<PostRunInspectionResult> => {
      onInspect?.(ctx, planResult);
      return {
        agentResult: {
          success: planResult.success,
          output: "",
          exitCode: 0,
          durationMs: 0,
          rateLimited: false,
          estimatedCostUsd: 0,
        },
        selfVerificationFailed: false,
        needsHumanReview: false,
        combinedOutput: "",
      };
    };
    return withExecutionDeps({
      ...baseOverrides,
      buildPlanForStrategy: async (callCtx: CallContext) => {
        const plan = new ExecutionPlan(callCtx, {}, false);
        plan.run = planRun;
        return plan;
      },
      recordRepoScopedFixes: recordSpy,
      applyPostRunInspection: inspectSpy,
      decideStageAction: async () => ({ action: "continue" }) as StageResult,
    });
  }

  function realRecorder(planRun: () => Promise<StoryOrchestratorResult>): () => void {
    const inspectStub = async (
      _ctx: PipelineContext,
      planResult: StoryOrchestratorResult,
    ): Promise<PostRunInspectionResult> => ({
      agentResult: {
        success: planResult.success,
        output: "",
        exitCode: 0,
        durationMs: 0,
        rateLimited: false,
        estimatedCostUsd: 0,
      },
      selfVerificationFailed: false,
      needsHumanReview: false,
      combinedOutput: "",
    });
    return withExecutionDeps({
      ...baseOverrides,
      buildPlanForStrategy: async (callCtx: CallContext) => {
        const plan = new ExecutionPlan(callCtx, {}, false);
        plan.run = planRun;
        return plan;
      },
      applyPostRunInspection: inspectStub,
      decideStageAction: async () => ({ action: "continue" }) as StageResult,
    });
  }

  it("AC9: calls recordRepoScopedFixes exactly once with ctx.story and the plan's records", async () => {
    const ctx = makeCtx();
    const records = [SAMPLE_RECORD];
    let callCount = 0;
    let receivedStory: unknown = null;
    let receivedRecords: unknown = null;
    const restore = spyRecord(
      async () => planResultWith({ repoScopedFixes: records }),
      (story, r) => {
        callCount++;
        receivedStory = story;
        receivedRecords = r;
      },
    );
    try {
      await executionStage.execute(ctx);
    } finally {
      restore();
    }
    expect(callCount).toBe(1);
    expect(receivedStory).toBe(ctx.story);
    expect(receivedRecords).toBe(records);
  });

  it("AC10: recordRepoScopedFixes runs before applyPostRunInspection", async () => {
    const ctx = makeCtx();
    const order: string[] = [];
    const restore = spyRecord(
      async () => planResultWith({ repoScopedFixes: [SAMPLE_RECORD] }),
      () => {
        order.push("record");
      },
      () => {
        order.push("inspect");
      },
    );
    try {
      await executionStage.execute(ctx);
    } finally {
      restore();
    }
    expect(order).toEqual(["record", "inspect"]);
  });

  it("AC11: leaves ctx.story.repoScopedFixes undefined when the plan result has no records", async () => {
    const ctx = makeCtx();
    const restore = realRecorder(async () => planResultWith({ success: true }));
    try {
      await executionStage.execute(ctx);
    } finally {
      restore();
    }
    expect(ctx.story.repoScopedFixes).toBeUndefined();
  });

  it("AC12: still records when the plan result has success=false", async () => {
    const ctx = makeCtx();
    const records = [SAMPLE_RECORD];
    const restore = realRecorder(async () => planResultWith({ success: false, repoScopedFixes: records }));
    try {
      await executionStage.execute(ctx);
    } finally {
      restore();
    }
    expect(ctx.story.repoScopedFixes).toHaveLength(1);
    expect(ctx.story.repoScopedFixes?.[0]).toEqual({
      triggeringTests: [...SAMPLE_RECORD.triggeringTests],
      filesChanged: [...SAMPLE_RECORD.filesChanged],
      findingsCleared: SAMPLE_RECORD.findingsCleared,
    });
  });

  it("AC13: rethrows plan.run() rejection", async () => {
    const ctx = makeCtx();
    const sentinel = new NaxError("boom", "CALL_OP_NO_OUTPUT", { stage: "execution", storyId: "US-recscope-01" });
    const restore = spyRecord(async () => {
      throw sentinel;
    });
    let caught: unknown = null;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      caught = err;
    } finally {
      restore();
    }
    expect(caught).toBe(sentinel);
  });

  it("AC13b: leaves ctx.story.repoScopedFixes undefined when plan.run() rejects", async () => {
    const ctx = makeCtx();
    const restore = realRecorder(async () => {
      throw new NaxError("boom", "CALL_OP_NO_OUTPUT", { stage: "execution", storyId: "US-recscope-01" });
    });
    try {
      await executionStage.execute(ctx);
    } catch {
      // expected
    } finally {
      restore();
    }
    expect(ctx.story.repoScopedFixes).toBeUndefined();
  });
});
