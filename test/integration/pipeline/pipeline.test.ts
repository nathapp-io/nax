// RE-ARCH: rewrite

/**
 * Pipeline Runner Tests
 *
 * Tests for the composable pipeline framework.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import type { NaxConfig } from "@/config/schema";
import { initLogger, resetLogger } from "@/logger";
import { runPipeline } from "@/pipeline/runner";
import type { PipelineContext, PipelineStage } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";

/** Helper: Create minimal test context */
function createTestContext(overrides?: Partial<PipelineContext>): PipelineContext {
  const story: UserStory = {
    id: "US-001",
    title: "Test Story",
    description: "Test description",
    acceptanceCriteria: ["Test passes"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };

  const prd: PRD = {
    project: "test-project",
    feature: "test-feature",
    branchName: "test-branch",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };

  return {
    config: {} as NaxConfig,
    rootConfig: DEFAULT_CONFIG,
    prd,
    story,
    stories: [story],
    routing: {
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "test-after",
      reasoning: "Test routing",
    },
    workdir: "/test/workdir",
    projectDir: "/test/workdir",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
    ...overrides,
  };
}

/** Helper: Create a simple stage that always continues */
function createContinueStage(name: string): PipelineStage {
  return {
    name,
    enabled: () => true,
    execute: async () => ({ action: "continue" }),
  };
}

describe("Pipeline Runner", () => {
  beforeEach(() => {
    initLogger({ level: "silent" });
  });

  afterEach(() => {
    resetLogger();
  });

  describe("runPipeline", () => {
    test("executes all stages when all return continue", async () => {
      const executedStages: string[] = [];

      const stages: PipelineStage[] = [
        {
          name: "stage1",
          enabled: () => true,
          execute: async () => {
            executedStages.push("stage1");
            return { action: "continue" };
          },
        },
        {
          name: "stage2",
          enabled: () => true,
          execute: async () => {
            executedStages.push("stage2");
            return { action: "continue" };
          },
        },
        {
          name: "stage3",
          enabled: () => true,
          execute: async () => {
            executedStages.push("stage3");
            return { action: "continue" };
          },
        },
      ];

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(true);
      expect(result.finalAction).toBe("complete");
      expect(result.stoppedAtStage).toBeUndefined();
      expect(result.reason).toBeUndefined();
      expect(executedStages).toEqual(["stage1", "stage2", "stage3"]);
    });

    test("skips disabled stages", async () => {
      const executedStages: string[] = [];

      const stages: PipelineStage[] = [
        {
          name: "enabled1",
          enabled: () => true,
          execute: async () => {
            executedStages.push("enabled1");
            return { action: "continue" };
          },
        },
        {
          name: "disabled",
          enabled: () => false,
          execute: async () => {
            executedStages.push("disabled");
            return { action: "continue" };
          },
        },
        {
          name: "enabled2",
          enabled: () => true,
          execute: async () => {
            executedStages.push("enabled2");
            return { action: "continue" };
          },
        },
      ];

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(true);
      expect(result.finalAction).toBe("complete");
      expect(executedStages).toEqual(["enabled1", "enabled2"]);
    });

    test("stops pipeline when stage returns skip, fail, escalate, or pause", async () => {
      const scenarios = [
        {
          action: "skip" as const,
          name: "skipStage",
          stageReturn: { action: "skip" as const, reason: "Story already completed" },
          expectedReason: "Story already completed",
        },
        {
          action: "fail" as const,
          name: "failStage",
          stageReturn: { action: "fail" as const, reason: "Tests failed" },
          expectedReason: "Tests failed",
        },
        {
          action: "escalate" as const,
          name: "escalateStage",
          stageReturn: { action: "escalate" as const },
          expectedReason: "Stage requested escalation to higher tier",
        },
        {
          action: "pause" as const,
          name: "pauseStage",
          stageReturn: { action: "pause" as const, reason: "User intervention required" },
          expectedReason: "User intervention required",
        },
      ];

      for (const { action, name, stageReturn, expectedReason } of scenarios) {
        const executedStages: string[] = [];
        const stages: PipelineStage[] = [
          {
            name: "stage1",
            enabled: () => true,
            execute: async () => {
              executedStages.push("stage1");
              return { action: "continue" };
            },
          },
          {
            name,
            enabled: () => true,
            execute: async () => {
              executedStages.push(name);
              return stageReturn as never;
            },
          },
          {
            name: "stage3",
            enabled: () => true,
            execute: async () => {
              executedStages.push("stage3");
              return { action: "continue" };
            },
          },
        ];
        const result = await runPipeline(stages, createTestContext());
        expect(result.success, action).toBe(false);
        expect(result.finalAction, action).toBe(action);
        expect(result.reason, action).toBe(expectedReason);
        expect(result.stoppedAtStage, action).toBe(name);
        expect(executedStages, action).toEqual(["stage1", name]);
      }
    });

    test("handles stage execution errors and non-Error exceptions", async () => {
      const executedStages: string[] = [];
      const stages: PipelineStage[] = [
        {
          name: "stage1",
          enabled: () => true,
          execute: async () => {
            executedStages.push("stage1");
            return { action: "continue" };
          },
        },
        {
          name: "errorStage",
          enabled: () => true,
          execute: async () => {
            executedStages.push("errorStage");
            throw new Error("Stage execution failed");
          },
        },
        {
          name: "stage3",
          enabled: () => true,
          execute: async () => {
            executedStages.push("stage3");
            return { action: "continue" };
          },
        },
      ];
      const r1 = await runPipeline(stages, createTestContext());
      expect(r1.success).toBe(false);
      expect(r1.finalAction).toBe("fail");
      expect(r1.reason).toContain('Stage "errorStage" threw error');
      expect(r1.reason).toContain("Stage execution failed");
      expect(r1.stoppedAtStage).toBe("errorStage");
      expect(executedStages).toEqual(["stage1", "errorStage"]);

      const r2 = await runPipeline(
        [
          {
            name: "throwStringStage",
            enabled: () => true,
            execute: async () => {
              throw "String error message";
            },
          },
        ],
        createTestContext(),
      );
      expect(r2.success).toBe(false);
      expect(r2.reason).toContain('Stage "throwStringStage" threw error');
      expect(r2.reason).toContain("String error message");
    });

    test("passes context through stages", async () => {
      const stages: PipelineStage[] = [
        {
          name: "setConstitution",
          enabled: () => true,
          execute: async (ctx) => {
            ctx.constitution = "Test constitution";
            return { action: "continue" };
          },
        },
        {
          name: "setContext",
          enabled: () => true,
          execute: async (ctx) => {
            ctx.contextMarkdown = "Test context";
            return { action: "continue" };
          },
        },
        {
          name: "verifyContext",
          enabled: () => true,
          execute: async (ctx) => {
            expect(ctx.constitution).toBe("Test constitution");
            expect(ctx.contextMarkdown).toBe("Test context");
            return { action: "continue" };
          },
        },
      ];

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(true);
      expect(result.context.constitution).toBe("Test constitution");
      expect(result.context.contextMarkdown).toBe("Test context");
    });

    test("returns updated context in result", async () => {
      const stages: PipelineStage[] = [
        {
          name: "modifyContext",
          enabled: () => true,
          execute: async (ctx) => {
            ctx.prompt = "Generated prompt";
            ctx.agentResult = {
              success: true,
              exitCode: 0,
              output: "Agent output",
              rateLimited: false,
              durationMs: 1000,
              estimatedCostUsd: 0.01,
            };
            return { action: "continue" };
          },
        },
      ];

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(true);
      expect(result.context.prompt).toBe("Generated prompt");
      expect(result.context.agentResult).toBeDefined();
      expect(result.context.agentResult?.success).toBe(true);
    });

    test("enabled function can access context", async () => {
      const stages: PipelineStage[] = [
        {
          name: "setRouting",
          enabled: () => true,
          execute: async (ctx) => {
            ctx.routing.complexity = "complex";
            return { action: "continue" };
          },
        },
        {
          name: "conditionalStage",
          enabled: (ctx) => ctx.routing.complexity === "complex",
          execute: async () => ({ action: "continue" }),
        },
      ];

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(true);
    });

    test("empty pipeline and all-disabled pipeline succeed immediately", async () => {
      const r1 = await runPipeline([], createTestContext());
      expect(r1.success).toBe(true);
      expect(r1.finalAction).toBe("complete");

      const stages: PipelineStage[] = [
        {
          name: "disabled1",
          enabled: () => false,
          execute: async () => {
            throw new Error("Should not execute");
          },
        },
        {
          name: "disabled2",
          enabled: () => false,
          execute: async () => {
            throw new Error("Should not execute");
          },
        },
      ];
      const r2 = await runPipeline(stages, createTestContext());
      expect(r2.success).toBe(true);
      expect(r2.finalAction).toBe("complete");
    });

    test("multiple skip stages only report first", async () => {
      const stages: PipelineStage[] = [
        createContinueStage("stage1"),
        {
          name: "skip1",
          enabled: () => true,
          execute: async () => ({ action: "skip", reason: "First skip" }),
        },
        {
          name: "skip2",
          enabled: () => true,
          execute: async () => ({ action: "skip", reason: "Second skip" }),
        },
      ];

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.finalAction).toBe("skip");
      expect(result.reason).toBe("First skip");
      expect(result.stoppedAtStage).toBe("skip1");
    });

    test("fail takes precedence over later stages", async () => {
      const stages: PipelineStage[] = [
        createContinueStage("stage1"),
        {
          name: "failStage",
          enabled: () => true,
          execute: async () => ({ action: "fail", reason: "Critical failure" }),
        },
        {
          name: "escalateStage",
          enabled: () => true,
          execute: async () => ({ action: "escalate" }),
        },
      ];

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.finalAction).toBe("fail");
      expect(result.reason).toBe("Critical failure");
      expect(result.stoppedAtStage).toBe("failStage");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// routeTddFailure — TDD failure routing by failureCategory
// ─────────────────────────────────────────────────────────────────────────────

import { routeTddFailure } from "@/pipeline/stages/execution";
import type { FailureCategory } from "@/tdd/types";
import { makeDispatchContext } from "@test/helpers";

describe("routeTddFailure", () => {
  /** Minimal context stub — only retryAsLite is used */
  function makeCtx(): { retryAsLite?: boolean } {
    return {};
  }

  describe("isolation-violation", () => {
    test("strict mode sets retryAsLite=true; lite mode does not", () => {
      const ctx1 = makeCtx();
      expect(routeTddFailure("isolation-violation", false, ctx1, "isolation error").action).toBe("escalate");
      expect(ctx1.retryAsLite).toBe(true);

      const ctx2 = makeCtx();
      expect(routeTddFailure("isolation-violation", true, ctx2, "isolation error lite").action).toBe("escalate");
      expect(ctx2.retryAsLite).toBeUndefined();
    });
  });

  describe("session-failure", () => {
    test("escalates in strict and lite mode; does not set retryAsLite", () => {
      const ctx1 = makeCtx();
      expect(routeTddFailure("session-failure", false, ctx1, "session crashed").action).toBe("escalate");
      expect(ctx1.retryAsLite).toBeUndefined();
      expect(routeTddFailure("session-failure", true, makeCtx()).action).toBe("escalate");
    });
  });

  describe("tests-failing, full-suite-gate-exhausted, verifier-rejected", () => {
    test("all return escalate without setting retryAsLite", () => {
      for (const cat of ["tests-failing", "full-suite-gate-exhausted", "verifier-rejected"] as const) {
        const ctx = makeCtx();
        expect(routeTddFailure(cat, false, ctx, `${cat} reason`).action, cat).toBe("escalate");
        expect(ctx.retryAsLite, cat).toBeUndefined();
      }
    });
  });

  describe("test-incorrect", () => {
    test("pauses with the verifier review reason", () => {
      const result = routeTddFailure("test-incorrect", false, makeCtx(), "Assertion conflicts with AC7");
      expect(result.action).toBe("pause");
      if (result.action === "pause") expect(result.reason).toBe("Assertion conflicts with AC7");
    });
  });

  describe("no failureCategory (backward compat)", () => {
    test("undefined category → pause with reviewReason, default message, and in lite mode", () => {
      const r1 = routeTddFailure(undefined, false, makeCtx(), "human review needed");
      expect(r1.action).toBe("pause");
      if (r1.action === "pause") expect(r1.reason).toBe("human review needed");

      const r2 = routeTddFailure(undefined, false, makeCtx());
      expect(r2.action).toBe("pause");
      if (r2.action === "pause") expect(r2.reason).toBe("Three-session TDD requires review");

      expect(routeTddFailure(undefined, true, makeCtx(), "lite mode no category").action).toBe("pause");
    });
  });

  describe("retryAsLite is not set for non-isolation failures", () => {
    const nonIsolationCategories: Array<FailureCategory | undefined> = [
      "session-failure",
      "tests-failing",
      "test-incorrect",
      "full-suite-gate-exhausted",
      "verifier-rejected",
      undefined,
    ];

    for (const category of nonIsolationCategories) {
      test(`category=${category ?? "undefined"} does not set retryAsLite`, () => {
        const ctx = makeCtx();
        routeTddFailure(category, false, ctx);
        expect(ctx.retryAsLite).toBeUndefined();
      });
    }
  });
});
