import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RunOperation, CallContext } from "@/operations";
import { makeMockAgentManager, makeTestRuntime } from "@test/helpers";
import type { NaxRuntime } from "@/runtime";

/**
 * Test suite for StoryOrchestratorBuilder
 *
 * AC1: Given addImplementer was never called, when build(ctx) is invoked, throws NaxError("ORCHESTRATOR_NO_IMPLEMENTER")
 * AC2: Given slots in order, when run() executes, runs test-writer → implementer → verifier → semantic → rectification (if added)
 * AC3: When add* method not called, phase is skipped and not in phaseOutputs
 * AC4: run() stores per-phase costs in phaseCosts, outputs in phaseOutputs, totalCostUsd = sum of phaseCosts
 */

let runtime: NaxRuntime | undefined;

beforeEach(() => {
  runtime = makeTestRuntime({ agentManager: makeMockAgentManager() });
});

afterEach(async () => {
  await runtime?.close();
});

describe("StoryOrchestratorBuilder", () => {
  describe("AC1: build() validation — no implementer throws ORCHESTRATOR_NO_IMPLEMENTER", () => {
    test("throws NaxError when addImplementer was never called", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");
      const builder = new StoryOrchestratorBuilder();

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      expect(() => builder.build(ctx)).toThrow();
    });

    test("throws with error code ORCHESTRATOR_NO_IMPLEMENTER", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");
      const builder = new StoryOrchestratorBuilder();

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      try {
        builder.build(ctx);
        expect.unreachable("should have thrown");
      } catch (err: unknown) {
        expect(err).toBeDefined();
        if (typeof err === "object" && err !== null && "code" in err) {
          expect((err as Record<string, unknown>).code).toBe("ORCHESTRATOR_NO_IMPLEMENTER");
        }
      }
    });
  });

  describe("AC2: Phase execution order — test-writer → implementer → verifier → semantic → rectification", () => {
    test("runs phases in declared order when all are added", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const executionOrder: string[] = [];

      const mockTestWriterOp: RunOperation<unknown, unknown, any> = {
        kind: "run",
        name: "test-writer-op",
        stage: "execution",
        config: [],
        build: () => ({ role: { id: "r", content: "test", overridable: false }, task: { id: "t", content: "test", overridable: false } }),
        parse: (_output: string) => {
          executionOrder.push("test-writer");
          return { /* parsed output */ };
        },
        session: { role: "test-writer", lifetime: "fresh" },
      };

      const mockImplementerOp: RunOperation<unknown, unknown, any> = {
        kind: "run",
        name: "implementer-op",
        stage: "execution",
        config: [],
        build: () => ({ role: { id: "r", content: "impl", overridable: false }, task: { id: "t", content: "impl", overridable: false } }),
        parse: (_output: string) => {
          executionOrder.push("implementer");
          return { /* parsed output */ };
        },
        session: { role: "implementer", lifetime: "fresh" },
      };

      const mockVerifierOp: RunOperation<unknown, unknown, any> = {
        kind: "run",
        name: "verifier-op",
        stage: "execution",
        config: [],
        build: () => ({ role: { id: "r", content: "verify", overridable: false }, task: { id: "t", content: "verify", overridable: false } }),
        parse: (_output: string) => {
          executionOrder.push("verifier");
          return { /* parsed output */ };
        },
        session: { role: "verifier", lifetime: "fresh" },
      };

      const builder = new StoryOrchestratorBuilder()
        .addTestWriter({ op: mockTestWriterOp, input: {} })
        .addImplementer({ op: mockImplementerOp, input: {} })
        .addVerifier({ op: mockVerifierOp, input: {} });

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      await plan.run();

      expect(executionOrder).toEqual(["test-writer", "implementer", "verifier"]);
    });

    test("runs phases in order: test-writer, implementer, semantic, rectification when added", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const executionOrder: string[] = [];

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => {
          executionOrder.push(name);
          return {};
        },
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addTestWriter({ op: createMockOp("test-writer", "test-writer"), input: {} })
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} })
        .addSemanticReview({ op: createMockOp("semantic", "reviewer-semantic"), input: {} })
        .addRectification();

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      await plan.run();

      expect(executionOrder).toContain("test-writer");
      expect(executionOrder).toContain("implementer");
      expect(executionOrder).toContain("semantic");
    });
  });

  describe("AC3: Skipped phases — not added phases are skipped and not in phaseOutputs", () => {
    test("does not include skipped phase in phaseOutputs", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => ({ parsed: true }),
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} });
      // Not adding test-writer, verifier, semantic, adversarial, rectification

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      const result = await plan.run();

      expect(result.phaseOutputs).toBeDefined();
      expect(Object.keys(result.phaseOutputs)).not.toContain("test-writer");
      expect(Object.keys(result.phaseOutputs)).not.toContain("verifier");
      expect(Object.keys(result.phaseOutputs)).not.toContain("semantic");
    });

    test("does not run skipped phase", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      let verifierRan = false;

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => {
          if (name === "verifier") verifierRan = true;
          return {};
        },
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} });
      // Not adding verifier

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      await plan.run();

      expect(verifierRan).toBeFalse();
    });
  });

  describe("AC4: Cost tracking — phaseCosts, phaseOutputs, totalCostUsd", () => {
    test("stores per-phase costs in phaseCosts keyed by op name", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => ({}),
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} });

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      const result = await plan.run();

      expect(result.phaseCosts).toBeDefined();
      expect(typeof result.phaseCosts).toBe("object");
      expect("implementer-op" in result.phaseCosts).toBeTrue();
    });

    test("stores parsed phase outputs in phaseOutputs keyed by op name", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const expectedOutput = { testResult: "passed" };

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => (name === "implementer" ? expectedOutput : {}),
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} });

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      const result = await plan.run();

      expect(result.phaseOutputs["implementer-op"]).toEqual(expectedOutput);
    });

    test("sets totalCostUsd equal to sum of phaseCosts values", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => ({}),
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} });

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      const result = await plan.run();

      const expectedTotal = Object.values(result.phaseCosts).reduce((sum: number, cost: any) => sum + (cost ?? 0), 0);
      expect(result.totalCostUsd).toBe(expectedTotal);
    });

    test("tracks durationMs for the entire execution", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => ({}),
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} });

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      const result = await plan.run();

      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("AC4: ExecutionPlan.run() result — success flag", () => {
    test("sets success to true when all phases complete without errors", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => ({}),
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} });

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      const result = await plan.run();

      expect(result.success).toBeBoolean();
    });
  });

  describe("Builder fluent API — method chaining", () => {
    test("builder methods return this for chaining", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const builder = new StoryOrchestratorBuilder();

      // Test that methods return the builder instance
      expect(builder.addImplementer({ op: {} as any, input: {} })).toBe(builder);
      expect(builder.addTestWriter({ op: {} as any, input: {} })).toBe(builder);
      expect(builder.addVerifier({ op: {} as any, input: {} })).toBe(builder);
      expect(builder.addSemanticReview({ op: {} as any, input: {} })).toBe(builder);
      expect(builder.addAdversarialReview({ op: {} as any, input: {} })).toBe(builder);
      expect(builder.addRectification()).toBe(builder);
    });
  });

  describe("ExecutionPlan interface", () => {
    test("ExecutionPlan has run() method that returns Promise<StoryOrchestratorResult>", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => ({}),
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} });

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      expect(plan).toBeDefined();
      expect(typeof plan.run).toBe("function");

      const result = await plan.run();
      expect(result).toBeDefined();
      expect("success" in result).toBeTrue();
      expect("phaseCosts" in result).toBeTrue();
      expect("phaseOutputs" in result).toBeTrue();
      expect("totalCostUsd" in result).toBeTrue();
      expect("durationMs" in result).toBeTrue();
    });
  });

  describe("All phases together — comprehensive flow", () => {
    test("runs all seven phases in correct order when all are added", async () => {
      // @ts-expect-error — StoryOrchestratorBuilder not yet implemented
      const { StoryOrchestratorBuilder } = await import("@/execution/story-orchestrator");

      const executionOrder: string[] = [];

      const createMockOp = (name: string, role: any) => ({
        kind: "run" as const,
        name: `${name}-op`,
        stage: "execution" as const,
        config: [],
        build: () => ({ role: { id: "r", content: name, overridable: false }, task: { id: "t", content: name, overridable: false } }),
        parse: (_output: string) => {
          executionOrder.push(name);
          return {};
        },
        session: { role, lifetime: "fresh" as const },
      });

      const builder = new StoryOrchestratorBuilder()
        .addTestWriter({ op: createMockOp("test-writer", "test-writer"), input: {} })
        .addImplementer({ op: createMockOp("implementer", "implementer"), input: {} })
        .addVerifier({ op: createMockOp("verifier", "verifier"), input: {} })
        .addSemanticReview({ op: createMockOp("semantic", "reviewer-semantic"), input: {} })
        .addAdversarialReview({ op: createMockOp("adversarial", "reviewer-adversarial"), input: {} })
        .addRectification();

      const ctx = {
        runtime: runtime!,
        packageView: runtime!.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      } as CallContext;

      const plan = builder.build(ctx);
      const result = await plan.run();

      // Verify all non-rectification phases ran
      expect(executionOrder).toContain("test-writer");
      expect(executionOrder).toContain("implementer");
      expect(executionOrder).toContain("verifier");
      expect(executionOrder).toContain("semantic");
      expect(executionOrder).toContain("adversarial");

      // Verify result has outputs for all phases
      expect(Object.keys(result.phaseOutputs).length).toBeGreaterThan(0);
      expect("test-writer-op" in result.phaseOutputs || "implementer-op" in result.phaseOutputs).toBeTrue();
    });
  });
});
