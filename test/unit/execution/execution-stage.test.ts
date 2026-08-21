// RE-ARCH: keep
/**
 * Tests for src/pipeline/stages/execution.ts
 *
 * Covers: routeTddFailure, execution stage critical paths
 */

import { describe, expect, it } from "bun:test";
import { _executionDeps, executionStage, routeTddFailure } from "@/pipeline/stages/execution";
import type { FailureCategory } from "@/tdd";
import { NaxError } from "@/errors";
import { makeAgentAdapter, makeNaxConfig } from "@test/helpers";
import { makeTestContext, makeTestStory } from "@test/helpers";
import type { PipelineContext } from "@/pipeline/types";
import type { StoryOrchestratorResult } from "@/execution/story-orchestrator";
import type { PostRunInspectionResult } from "@/execution/post-run";
import type { StageResult } from "@/pipeline/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface MockContext {
  retryAsLite?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// routeTddFailure
// ─────────────────────────────────────────────────────────────────────────────

describe("routeTddFailure", () => {
  it("escalates on isolation-violation in strict mode with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("isolation-violation", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD isolation-violation");
    expect(ctx.retryAsLite).toBe(true);
  });

  it("escalates on isolation-violation in lite mode without setting retryAsLite", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("isolation-violation", true, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD isolation-violation");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on session-failure with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("session-failure", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD session-failure");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on tests-failing with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("tests-failing", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD tests-failing");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on full-suite-gate-exhausted with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("full-suite-gate-exhausted", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD full-suite-gate-exhausted");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on verifier-rejected with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("verifier-rejected", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD verifier-rejected");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on review-incomplete with category in reason (US-002)", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("review-incomplete", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD review-incomplete");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on greenfield-no-tests with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("greenfield-no-tests", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD greenfield-no-tests");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("appends failureDetail to escalate reason when provided", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("tests-failing", false, ctx, undefined, "3 tests failing in foo.test.ts");

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD tests-failing: 3 tests failing in foo.test.ts");
  });

  it("pauses on undefined failureCategory", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx, "Unknown failure");

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Unknown failure");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("pauses on unknown failureCategory", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("unknown" as FailureCategory, false, ctx);

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Three-session TDD requires review");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("pauses on dependency-prep (infra prep failure, not tier-recoverable)", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("dependency-prep", false, ctx);

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Three-session TDD requires review");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("pauses on test-incorrect with the verifier's review reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("test-incorrect", false, ctx, "Incorrect assertion; human review required");

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Incorrect assertion; human review required");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("uses custom reviewReason when pausing", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx, "Custom reason for pause");

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Custom reason for pause");
  });

  it("defaults to generic pause message when no reviewReason provided", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx);

    expect(result.action).toBe("pause");
    if (result.action === "pause") expect(result.reason).toBe("Three-session TDD requires review");
  });

  it("handles all known failure categories correctly", () => {
    const categories: FailureCategory[] = [
      "isolation-violation",
      "session-failure",
      "tests-failing",
      "full-suite-gate-exhausted",
      "verifier-rejected",
      "runtime-crash",
    ];

    for (const category of categories) {
      const ctx: MockContext = {};
      const result = routeTddFailure(category, false, ctx);
      expect(result.action).toBe("escalate");
    }
  });

  it("only sets retryAsLite for isolation-violation in strict mode", () => {
    const categories: FailureCategory[] = [
      "session-failure",
      "tests-failing",
      "full-suite-gate-exhausted",
      "verifier-rejected",
    ];

    for (const category of categories) {
      const ctx: MockContext = {};
      routeTddFailure(category, false, ctx);
      expect(ctx.retryAsLite).toBeUndefined();
    }
  });

  // issue #1132
  it("escalates on runtime-crash with category in reason", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("runtime-crash", false, ctx);

    expect(result.action).toBe("escalate");
    if (result.action === "escalate") expect(result.reason).toBe("TDD runtime-crash");
    expect(ctx.retryAsLite).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executionStage.execute — runtime-crash category on plan.run() throw (#1132)
// ─────────────────────────────────────────────────────────────────────────────

describe("executionStage.execute — runtime-crash on thrown infra errors", () => {
  const cfg = makeNaxConfig();

  // Shared PipelineContext factory — overrides only the fields execution stage needs.
  function makeCtx(): PipelineContext {
    return makeTestContext({
      story: makeTestStory({ id: "US-crash-01", title: "Crash test" }),
      config: cfg,
      workdir: "/tmp/nax-crash-test",
      routing: { modelTier: "fast", testStrategy: "three-session-tdd", agent: "claude", complexity: "simple", reasoning: "" },
      packageView: { select: () => cfg } as unknown as PipelineContext["packageView"],
      // runtime lives on the DispatchContext parent — cast to satisfy Partial<PipelineContext>
      ...({
        runtime: {
          dispatchEvents: { onDispatch: () => () => {} },
          signal: undefined,
          packages: undefined,
          onPidSpawned: undefined,
        },
      } as unknown as Partial<PipelineContext>),
    });
  }

  // Stub _executionDeps so plan.run() is the only thing that can throw.
  // Returns a restore function — call it in the test's own finally block.
  function stubDepsWithPlan(planRun: () => Promise<never>): () => void {
    const saved = { ..._executionDeps };
    _executionDeps.getAgent = () => makeAgentAdapter({ name: "claude" }) as never;
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.captureGitRef = async () => "HEAD";
    _executionDeps.getUntrackedPaths = async () => [];
    _executionDeps.assemblePlanInputsFromCtx = async () => ({}) as never;
    (_executionDeps as Record<string, unknown>)["buildPlanForStrategy"] = async () => ({
      run: planRun,
    });
    return () => Object.assign(_executionDeps, saved);
  }

  it("sets tddFailureCategory to runtime-crash when plan.run() throws CALL_OP_NO_OUTPUT", async () => {
    // AC-1: CALL_OP_NO_OUTPUT → runtime-crash
    const ctx = makeCtx();
    const restore = stubDepsWithPlan(async () => {
      throw new NaxError("agent returned no output", "CALL_OP_NO_OUTPUT", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });
    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_NO_OUTPUT");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBe("runtime-crash");
  });

  it("sets tddFailureCategory to runtime-crash when plan.run() throws CALL_OP_MAX_RETRIES", async () => {
    // AC-1: CALL_OP_MAX_RETRIES → runtime-crash
    const ctx = makeCtx();
    const restore = stubDepsWithPlan(async () => {
      throw new NaxError("retry budget exhausted", "CALL_OP_MAX_RETRIES", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });
    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_MAX_RETRIES");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBe("runtime-crash");
  });

  it("does NOT set tddFailureCategory when plan.run() throws CALL_OP_ABORTED", async () => {
    // AC-3: user-initiated abort must not be classified as runtime-crash
    const ctx = makeCtx();
    const restore = stubDepsWithPlan(async () => {
      throw new NaxError("aborted", "CALL_OP_ABORTED", {
        stage: "execution",
        storyId: "US-crash-01",
      });
    });
    let threw = false;
    try {
      await executionStage.execute(ctx);
    } catch (err) {
      threw = true;
      expect((err as NaxError).code).toBe("CALL_OP_ABORTED");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(ctx.tddFailureCategory).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executionStage.execute — recordRepoScopedFixes wiring (US-002)
// ─────────────────────────────────────────────────────────────────────────────

interface PlanResultOptions {
  readonly success?: boolean;
  readonly repoScopedFixes?: readonly { triggeringTests: readonly string[]; filesChanged: readonly string[]; findingsCleared: boolean }[];
}

function planResultWith(opts: PlanResultOptions): {
  success: boolean;
  phaseCosts: Record<string, number>;
  totalCostUsd: number;
  durationMs: number;
  phaseOutputs: Record<string, unknown>;
  repoScopedFixes?: readonly { triggeringTests: readonly string[]; filesChanged: readonly string[]; findingsCleared: boolean }[];
  outputFiles: string[];
  diffSummary: string;
} {
  const result: {
    success: boolean;
    phaseCosts: Record<string, number>;
    totalCostUsd: number;
    durationMs: number;
    phaseOutputs: Record<string, unknown>;
    repoScopedFixes?: readonly { triggeringTests: readonly string[]; filesChanged: readonly string[]; findingsCleared: boolean }[];
    outputFiles: string[];
    diffSummary: string;
  } = {
    success: opts.success ?? true,
    phaseCosts: {},
    totalCostUsd: 0,
    durationMs: 0,
    phaseOutputs: {},
    outputFiles: [],
    diffSummary: "",
  };
  if (opts.repoScopedFixes) result.repoScopedFixes = opts.repoScopedFixes;
  return result;
}

const SAMPLE_RECORD = {
  triggeringTests: ["test/legacy/auth.spec.ts::redirects to login"],
  filesChanged: ["src/legacy/auth.ts"],
  findingsCleared: true,
};

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

  // Spy-mode stub: replaces the recorder with a spy so the test can assert
  // call ordering / arguments, but the real mapper is NOT used.
  function stubDepsWithSpy(opts: {
    planRun: () => Promise<ReturnType<typeof planResultWith>>;
    onRecord?: ((s: unknown, r: unknown) => void) | undefined;
    onInspect?: ((s: unknown, p: unknown) => void) | undefined;
  }): () => void {
    const saved = { ..._executionDeps };
    _executionDeps.getAgent = () => makeAgentAdapter({ name: "claude" }) as never;
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.captureGitRef = async () => "HEAD";
    _executionDeps.getUntrackedPaths = async () => [];
    _executionDeps.assemblePlanInputsFromCtx = async () => ({}) as never;
    (_executionDeps as Record<string, unknown>)["buildPlanForStrategy"] = async () => ({
      run: opts.planRun,
    });
    const recordSpy = (story: unknown, records: unknown) => {
      opts.onRecord?.(story, records);
    };
    _executionDeps.recordRepoScopedFixes = recordSpy as typeof _executionDeps.recordRepoScopedFixes;
    _executionDeps.applyPostRunInspection = (async (ctx: PipelineContext, planResult: StoryOrchestratorResult): Promise<PostRunInspectionResult> => {
      opts.onInspect?.(ctx, planResult);
      return {
        agentResult: { success: planResult.success, output: "", exitCode: 0, durationMs: 0, rateLimited: false, estimatedCostUsd: 0 },
        selfVerificationFailed: false,
        needsHumanReview: false,
        combinedOutput: "",
      };
    }) as typeof _executionDeps.applyPostRunInspection;
    _executionDeps.decideStageAction = ((() => ({ action: "continue" } as StageResult)) as unknown) as typeof _executionDeps.decideStageAction;
    return () => Object.assign(_executionDeps, saved);
  }

  // Real-mode stub: keeps the real `recordRepoScopedFixes` mapper so the test
  // can observe its effect on `ctx.story`. Only `applyPostRunInspection` is
  // stubbed to avoid real post-run work.
  function stubDepsWithRealRecorder(opts: {
    planRun: () => Promise<ReturnType<typeof planResultWith>>;
  }): () => void {
    const saved = { ..._executionDeps };
    _executionDeps.getAgent = () => makeAgentAdapter({ name: "claude" }) as never;
    _executionDeps.validateAgentForTier = () => true;
    _executionDeps.captureGitRef = async () => "HEAD";
    _executionDeps.getUntrackedPaths = async () => [];
    _executionDeps.assemblePlanInputsFromCtx = async () => ({}) as never;
    (_executionDeps as Record<string, unknown>)["buildPlanForStrategy"] = async () => ({
      run: opts.planRun,
    });
    _executionDeps.applyPostRunInspection = (async (_ctx: PipelineContext, planResult: StoryOrchestratorResult): Promise<PostRunInspectionResult> => ({
      agentResult: { success: planResult.success, output: "", exitCode: 0, durationMs: 0, rateLimited: false, estimatedCostUsd: 0 },
      selfVerificationFailed: false,
      needsHumanReview: false,
      combinedOutput: "",
    })) as typeof _executionDeps.applyPostRunInspection;
    _executionDeps.decideStageAction = ((() => ({ action: "continue" } as StageResult)) as unknown) as typeof _executionDeps.decideStageAction;
    return () => Object.assign(_executionDeps, saved);
  }

  it("AC9: calls recordRepoScopedFixes exactly once with ctx.story and the plan's records", async () => {
    const ctx = makeCtx();
    const records = [SAMPLE_RECORD];
    let callCount = 0;
    let receivedStory: unknown = null;
    let receivedRecords: unknown = null;
    const restore = stubDepsWithSpy({
      planRun: async () => planResultWith({ repoScopedFixes: records }),
      onRecord: (story, r) => {
        callCount++;
        receivedStory = story;
        receivedRecords = r;
      },
    });
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
    const restore = stubDepsWithSpy({
      planRun: async () => planResultWith({ repoScopedFixes: [SAMPLE_RECORD] }),
      onRecord: () => {
        order.push("record");
      },
      onInspect: () => {
        order.push("inspect");
      },
    });
    try {
      await executionStage.execute(ctx);
    } finally {
      restore();
    }
    expect(order).toEqual(["record", "inspect"]);
  });

  it("AC11: leaves ctx.story.repoScopedFixes undefined when the plan result has no records", async () => {
    const ctx = makeCtx();
    const restore = stubDepsWithRealRecorder({
      planRun: async () => planResultWith({ success: true }),
    });
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
    const restore = stubDepsWithRealRecorder({
      planRun: async () => planResultWith({ success: false, repoScopedFixes: records }),
    });
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
    const restore = stubDepsWithSpy({
      planRun: async () => {
        throw sentinel;
      },
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

  it("AC14: leaves ctx.story.repoScopedFixes undefined when plan.run() rejects", async () => {
    const ctx = makeCtx();
    const restore = stubDepsWithRealRecorder({
      planRun: async () => {
        throw new NaxError("boom", "CALL_OP_NO_OUTPUT", { stage: "execution", storyId: "US-recscope-01" });
      },
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
