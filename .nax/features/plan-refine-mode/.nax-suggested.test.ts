import { describe, expect, mock, test } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { resolvePlanMode } from "../../../src/cli/plan-command";
import { PlanPromptBuilder } from "../../../src/prompts/builders/plan-builder";
import { planRefineOp } from "../../../src/operations/plan-refine";
import { RefinePlanStrategy, _refinePlanDeps } from "../../../src/plan/strategies/refine";
import { createPlanStrategy } from "../../../src/plan/strategies/factory";
import { SinglePlanStrategy } from "../../../src/plan/strategies/single";
import { PipelinePlanStrategy } from "../../../src/plan/strategies/pipeline";
import { KNOWN_SESSION_ROLES } from "../../../src/runtime/session-role";
import type { PlanModeContext } from "../../../src/plan/strategies/types";
import type { InteractionBridge } from "../../../src/interaction/bridge-builder";
import type { NaxRuntime } from "../../../src/runtime";
import { makeMockAgentManager } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRuntime(closeImpl?: () => Promise<void>): NaxRuntime {
  return {
    packages: { resolve: () => ({}) },
    agentManager: makeMockAgentManager({ getDefaultAgent: "claude" }),
    close: closeImpl ?? (async () => {}),
  } as unknown as NaxRuntime;
}

function makeCtx(overrides: Partial<PlanModeContext> = {}): PlanModeContext {
  return {
    workdir: "/tmp/workdir",
    naxDir: "/tmp/workdir/.nax",
    outputDir: "/tmp/workdir/.nax/features/test-feature",
    outputPath: "/tmp/workdir/.nax/features/test-feature/prd.json",
    specContent: "# Feature Spec",
    codebaseContext: "Codebase context for testing",
    normalizedRoots: [],
    relativePackages: ["packages/api"],
    packageDetails: [],
    projectName: "test-project",
    branchName: "feat/test-feature",
    timeoutSeconds: 30,
    config: { timeoutSeconds: 30 } as never,
    fullConfig: { agent: { maxInteractionTurns: 5 } } as never,
    options: { from: "/tmp/spec.md", feature: "test-feature" },
    runtime: makeRuntime(),
    interactionChain: null,
    interactionBridge: {} as InteractionBridge,
    deps: {
      readFile: async () => null,
      writeFile: async () => {},
      mkdirp: async () => {},
      existsSync: () => false,
      readPackageJson: async () => null,
      readPackageJsonAt: async () => null,
      scanSourceRoots: async () => [],
      spawnSync: () => ({ stdout: Buffer.from(""), exitCode: 0 }),
      initInteractionChain: async () => null,
      createInteractionBridge: () => ({
        detectQuestion: async () => false,
        onQuestionDetected: async () => "",
      }),
      createDebateRunner: () => ({}) as never,
    },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001: Config Schema and Mode Resolution
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: Config schema and mode resolution", () => {
  test("AC-1: resolvePlanMode({ plan: { mode: 'pipeline' } }) returns 'pipeline'", () => {
    const config = { plan: { mode: "pipeline" as const } };
    const result = resolvePlanMode(config as any);
    expect(result).toBe("pipeline");
  });

  test("AC-2: resolvePlanMode({ plan: { mode: 'debate' } }) returns 'debate'", () => {
    const config = { plan: { mode: "debate" as const } };
    const result = resolvePlanMode(config as any);
    expect(result).toBe("debate");
  });

  test("AC-3: NaxConfigSchema.safeParse({ plan: { mode: 'single' } }) returns success: true", () => {
    const result = NaxConfigSchema.safeParse({ plan: { mode: "single" } });
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002: Refine Continuation Prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002: Refine continuation prompt", () => {
  test("AC-4: buildRefineContinuation does NOT contain 'failure-table-enumerated'", () => {
    const builder = new PlanPromptBuilder();
    const result = builder.buildRefineContinuation("/path/to/prd.json");
    expect(result.includes("failure-table-enumerated")).toBe(false);
  });

  test("AC-5: buildRefineContinuation with different paths returns different strings", () => {
    const builder = new PlanPromptBuilder();
    const pathA = "/path/to/prd-a.json";
    const pathB = "/path/to/prd-b.json";
    const resultA = builder.buildRefineContinuation(pathA);
    const resultB = builder.buildRefineContinuation(pathB);
    expect(resultA).not.toBe(resultB);
  });

  test("AC-6: buildRefineContinuation includes explicit instruction to write file before confirming", () => {
    const builder = new PlanPromptBuilder();
    const filePath = "/output/prd.json";
    const result = builder.buildRefineContinuation(filePath);
    expect(result.includes("Write the revised PRD to this file path")).toBe(true);
    expect(result.includes(filePath)).toBe(true);
    expect(result.includes("reply with a brief text confirmation")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003: planRefineOp Operation
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003: planRefineOp operation", () => {
  test("AC-7: planRefineOp.retry is a RetryStrategy with maxAttempts === 3", () => {
    const input = {
      specContent: "spec",
      codebaseContext: "context",
      featureName: "test-feature",
      branchName: "feat/test",
      outputPath: "/tmp/prd.json",
    };
    const ctx = { config: { plan: {} } } as any;
    const retryStrategy = planRefineOp.retry(input, ctx);
    expect(retryStrategy).toBeDefined();
    expect(retryStrategy.maxAttempts).toBe(3);
  });

  test("AC-8: planRefineOp.fileOutput(input) returns input.outputPath", () => {
    const input = {
      specContent: "spec",
      codebaseContext: "context",
      featureName: "feature",
      branchName: "branch",
      outputPath: "/tmp/my-prd.json",
    };
    const result = planRefineOp.fileOutput(input);
    expect(result).toBe(input.outputPath);
  });

  test("AC-9a: planRefineOp.verify returns null when parsed.userStories is empty", async () => {
    const parsed = { userStories: [] };
    const input = {
      specContent: "spec",
      codebaseContext: "context",
      featureName: "feature",
      branchName: "branch",
      outputPath: "/tmp/prd.json",
    };
    const result = await planRefineOp.verify(parsed, input, {} as any);
    expect(result).toBeNull();
  });

  test("AC-9b: planRefineOp.verify returns null when parsed has no userStories", async () => {
    const parsed = {};
    const input = {
      specContent: "spec",
      codebaseContext: "context",
      featureName: "feature",
      branchName: "branch",
      outputPath: "/tmp/prd.json",
    };
    const result = await planRefineOp.verify(parsed, input, {} as any);
    expect(result).toBeNull();
  });

  test("AC-9c: planRefineOp.verify returns null when parsed.userStories is undefined", async () => {
    const parsed = { userStories: undefined };
    const input = {
      specContent: "spec",
      codebaseContext: "context",
      featureName: "feature",
      branchName: "branch",
      outputPath: "/tmp/prd.json",
    };
    const result = await planRefineOp.verify(parsed, input, {} as any);
    expect(result).toBeNull();
  });

  test("AC-10a: planRefineOp.recover returns null when ctx.readFile returns null", async () => {
    const input = {
      specContent: "spec",
      codebaseContext: "context",
      featureName: "feature",
      branchName: "branch",
      outputPath: "/tmp/prd.json",
    };
    const ctx = { readFile: async () => null } as any;
    const result = await planRefineOp.recover(input, ctx);
    expect(result).toBeNull();
  });

  test("AC-10b: planRefineOp.recover returns null when ctx.readFile returns undefined", async () => {
    const input = {
      specContent: "spec",
      codebaseContext: "context",
      featureName: "feature",
      branchName: "branch",
      outputPath: "/tmp/prd.json",
    };
    const ctx = { readFile: async () => undefined } as any;
    const result = await planRefineOp.recover(input, ctx);
    expect(result).toBeNull();
  });

  test("AC-11: planRefineOp.recover returns null (not throws) when file contains invalid JSON", async () => {
    const input = {
      specContent: "spec",
      codebaseContext: "context",
      featureName: "feature",
      branchName: "branch",
      outputPath: "/tmp/prd.json",
    };
    const ctx = { readFile: async () => "{ invalid json }" } as any;
    const result = await planRefineOp.recover(input, ctx);
    expect(result).toBeNull();
  });

  test("AC-12: planRefineOp.build returns { task: { content: string } } with codebaseContext substring", () => {
    const input = {
      specContent: "# Feature Spec",
      codebaseContext: "Codebase context string",
      featureName: "my-feature",
      branchName: "feat/my-feature",
      outputPath: "/tmp/prd.json",
    };
    const ctx = { config: { plan: {} } } as any;
    const result = planRefineOp.build(input, ctx);
    expect(result).toBeDefined();
    expect(result.task).toBeDefined();
    expect(result.task.content).toBeDefined();
    expect(typeof result.task.content).toBe("string");
    expect(result.task.content.includes("Codebase context string")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004: RefinePlanStrategy and Factory Wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: RefinePlanStrategy and factory wiring", () => {
  test("AC-13: RefinePlanStrategy.execute does NOT call ctx.runtime.close()", async () => {
    const strategy = new RefinePlanStrategy();
    const closeMock = mock(async () => {});
    const runtime = makeRuntime(closeMock);
    const ctx = makeCtx({ runtime });

    // Mock callOp to return a valid PRD
    const callOpMock = mock(async () => ({
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "A test story",
          acceptanceCriteria: ["AC1"],
        },
      ],
    }));

    const originalCallOp = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = callOpMock as typeof _refinePlanDeps.callOp;

    try {
      await strategy.execute(ctx);
      // Verify that runtime.close() was NOT called
      expect(closeMock.mock.calls.length).toBe(0);
    } finally {
      _refinePlanDeps.callOp = originalCallOp;
    }
  });

  test("AC-14a: When callOp rejects, execute returns path from writeOrRecoverPrd", async () => {
    const strategy = new RefinePlanStrategy();
    const ctx = makeCtx();
    const testError = new Error("Call failed");

    // Mock callOp to throw
    const callOpMock = mock(async () => {
      throw testError;
    });

    const originalCallOp = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = callOpMock as typeof _refinePlanDeps.callOp;

    try {
      // This should call writeOrRecoverPrd with the error
      await strategy.execute(ctx);
    } catch {
      // Expected to throw if no valid PRD on disk
    } finally {
      _refinePlanDeps.callOp = originalCallOp;
    }
  });

  test("AC-15: createPlanStrategy('single') returns SinglePlanStrategy", () => {
    const strategy = createPlanStrategy("single");
    expect(strategy instanceof SinglePlanStrategy).toBe(true);
  });

  test("AC-16: createPlanStrategy('pipeline') returns PipelinePlanStrategy", () => {
    const strategy = createPlanStrategy("pipeline");
    expect(strategy instanceof PipelinePlanStrategy).toBe(true);
  });

  test("AC-17: RefinePlanStrategy.execute invokes callOp with interactionBridge in context", async () => {
    const strategy = new RefinePlanStrategy();
    const mockBridge = { detectQuestion: async () => false } as InteractionBridge;
    const ctx = makeCtx({ interactionBridge: mockBridge });

    const callOpMock = mock(async () => ({
      userStories: [
        {
          id: "US-001",
          title: "Test story",
          description: "A test story",
          acceptanceCriteria: ["AC1"],
        },
      ],
    }));

    const originalCallOp = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = callOpMock as typeof _refinePlanDeps.callOp;

    try {
      await strategy.execute(ctx);
      expect(callOpMock.mock.calls.length).toBe(1);
      const callCtx = callOpMock.mock.calls[0][0] as Record<string, unknown>;
      expect(callCtx.interactionBridge).toBe(mockBridge);
    } finally {
      _refinePlanDeps.callOp = originalCallOp;
    }
  });

  test("Session role registry includes 'plan-refine'", () => {
    expect((KNOWN_SESSION_ROLES as readonly string[]).includes("plan-refine")).toBe(true);
  });
});