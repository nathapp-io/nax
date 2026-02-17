/**
 * Pipeline Runner Tests
 *
 * Tests for the composable pipeline framework.
 */

import { describe, test, expect } from "bun:test";
import { runPipeline } from "../src/pipeline/runner";
import type { PipelineContext, PipelineStage } from "../src/pipeline/types";
import type { NgentConfig } from "../src/config/schema";
import type { PRD, UserStory } from "../src/prd/types";

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
    config: {} as NgentConfig,
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
    hooks: { hooks: {} },
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

    test("stops when stage returns skip", async () => {
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
          name: "skipStage",
          enabled: () => true,
          execute: async () => {
            executedStages.push("skipStage");
            return { action: "skip", reason: "Story already completed" };
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

      expect(result.success).toBe(false);
      expect(result.finalAction).toBe("skip");
      expect(result.reason).toBe("Story already completed");
      expect(result.stoppedAtStage).toBe("skipStage");
      expect(executedStages).toEqual(["stage1", "skipStage"]);
    });

    test("stops when stage returns fail", async () => {
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
          name: "failStage",
          enabled: () => true,
          execute: async () => {
            executedStages.push("failStage");
            return { action: "fail", reason: "Tests failed" };
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

      expect(result.success).toBe(false);
      expect(result.finalAction).toBe("fail");
      expect(result.reason).toBe("Tests failed");
      expect(result.stoppedAtStage).toBe("failStage");
      expect(executedStages).toEqual(["stage1", "failStage"]);
    });

    test("stops when stage returns escalate", async () => {
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
          name: "escalateStage",
          enabled: () => true,
          execute: async () => {
            executedStages.push("escalateStage");
            return { action: "escalate" };
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

      expect(result.success).toBe(false);
      expect(result.finalAction).toBe("escalate");
      expect(result.reason).toBe("Stage requested escalation to higher tier");
      expect(result.stoppedAtStage).toBe("escalateStage");
      expect(executedStages).toEqual(["stage1", "escalateStage"]);
    });

    test("stops when stage returns pause", async () => {
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
          name: "pauseStage",
          enabled: () => true,
          execute: async () => {
            executedStages.push("pauseStage");
            return { action: "pause", reason: "User intervention required" };
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

      expect(result.success).toBe(false);
      expect(result.finalAction).toBe("pause");
      expect(result.reason).toBe("User intervention required");
      expect(result.stoppedAtStage).toBe("pauseStage");
      expect(executedStages).toEqual(["stage1", "pauseStage"]);
    });

    test("handles stage execution errors", async () => {
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

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(false);
      expect(result.finalAction).toBe("fail");
      expect(result.reason).toContain('Stage "errorStage" threw error');
      expect(result.reason).toContain("Stage execution failed");
      expect(result.stoppedAtStage).toBe("errorStage");
      expect(executedStages).toEqual(["stage1", "errorStage"]);
    });

    test("handles non-Error exceptions", async () => {
      const stages: PipelineStage[] = [
        {
          name: "throwStringStage",
          enabled: () => true,
          execute: async () => {
            throw "String error message";
          },
        },
      ];

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(false);
      expect(result.finalAction).toBe("fail");
      expect(result.reason).toContain('Stage "throwStringStage" threw error');
      expect(result.reason).toContain("String error message");
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
              estimatedCost: 0.01,
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

    test("empty pipeline succeeds immediately", async () => {
      const stages: PipelineStage[] = [];
      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(true);
      expect(result.finalAction).toBe("complete");
    });

    test("pipeline with only disabled stages succeeds", async () => {
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

      const ctx = createTestContext();
      const result = await runPipeline(stages, ctx);

      expect(result.success).toBe(true);
      expect(result.finalAction).toBe("complete");
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
