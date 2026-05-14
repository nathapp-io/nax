import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { PlanPromptBuilder } from "@/prompts";
import { planInteractiveOp } from "@/operations";
import type { VerifyContext } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import { makeTestRuntime } from "@test/helpers";
import type { HopBodyContext } from "@/operations/types";

const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  mock.restore();
  await Promise.allSettled(createdRuntimes.map((runtime) => runtime.close()));
  createdRuntimes.length = 0;
});

function makeValidPrd(feature: string, branchName: string) {
  return {
    project: "test-project",
    feature,
    analysis: "test analysis",
    branchName,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: [
      {
        id: "US-001",
        title: "Test story",
        description: "Test description",
        acceptanceCriteria: ["Test AC"],
        contextFiles: [],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        routing: {
          complexity: "simple",
          testStrategy: "no-test",
          noTestJustification: "test",
          reasoning: "test",
        },
        escalations: [],
        attempts: 0,
      },
    ],
  };
}

describe("planRefineOp export and identity", () => {
  test("exports planRefineOp from the operations barrel", async () => {
    const mod = await import("@/operations");
    expect(mod).toHaveProperty("planRefineOp");
  });

  test("has kind run and name plan-refine", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    expect(planRefineOp.kind).toBe("run");
    expect(planRefineOp.name).toBe("plan-refine");
  });

  test("uses the plan-refine session role with a fresh lifetime", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    expect(planRefineOp.session.role).toBe("plan-refine");
    expect(planRefineOp.session.lifetime).toBe("fresh");
  });

  test("defines config and retry for the two-turn refine flow", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    expect(planRefineOp.config).toBeDefined();
    expect(planRefineOp.retry).toBeDefined();
    expect(typeof planRefineOp.retry).toBe("function");
  });

  test("defines fileOutput so callOp can substitute written PRD content", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const outputPath = "/tmp/plan-refine-prd.json";
    expect(planRefineOp.fileOutput?.({ outputPath } as never)).toBe(outputPath);
  });
});

describe("planRefineOp.build()", () => {
  test("returns a ComposeInput whose task content includes the feature name", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx = { packageView: view, config: view.select(planInteractiveOp.config) };

    const result = planRefineOp.build(
      {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/prd.json",
      },
      ctx,
    );

    expect(result.task.content).toContain("checkout-flow");
  });
});

describe("planRefineOp.hopBody()", () => {
  test("calls sendWithParseRetry for the draft turn and send for the refine turn", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const initialPrompt = "draft prompt";
    const refinePrompt = "refine prompt";

    const sendWithParseRetry = mock(async (_prompt: string) => ({
      output: "draft-confirmation",
      estimatedCostUsd: 1.25,
      internalRoundTrips: 1,
      tokenUsage: { inputTokens: 1, outputTokens: 1 },
    }));
    const send = mock(async (_prompt: string) => ({
      output: "refined-confirmation",
      estimatedCostUsd: 2.75,
      internalRoundTrips: 2,
      tokenUsage: { inputTokens: 2, outputTokens: 2 },
    }));
    const buildRefineContinuationSpy = spyOn(PlanPromptBuilder.prototype, "buildRefineContinuation").mockReturnValue(
      refinePrompt,
    );

    const ctx: HopBodyContext<{
      specContent: string;
      codebaseContext: string;
      featureName: string;
      branchName: string;
      outputPath: string;
    }> = {
      input: {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/plan-refine-prd.json",
      },
      send,
      sendWithParseRetry,
    };

    const result = await planRefineOp.hopBody(initialPrompt, ctx);

    expect(sendWithParseRetry).toHaveBeenCalledTimes(1);
    expect(sendWithParseRetry).toHaveBeenCalledWith(initialPrompt);
    expect(send).toHaveBeenCalledTimes(1);
    expect(buildRefineContinuationSpy).toHaveBeenCalledTimes(1);
    expect(buildRefineContinuationSpy).toHaveBeenCalledWith("/tmp/plan-refine-prd.json");
    expect(send).toHaveBeenCalledWith(refinePrompt);
    expect(result.output).toBe("refined-confirmation");
    expect(result.estimatedCostUsd).toBe(4);
  });
});

describe("planRefineOp.recover()", () => {
  test("returns null when the output file is missing", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: VerifyContext<unknown> = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await planRefineOp.recover?.(
      {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/missing-prd.json",
      },
      ctx,
    );

    expect(result).toBeNull();
  });

  test("returns a parsed PRD when the output file contains valid JSON", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const validPrd = makeValidPrd("checkout-flow", "feat/checkout");
    const ctx: VerifyContext<unknown> = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async () => JSON.stringify(validPrd),
      fileExists: async () => true,
    };

    const result = await planRefineOp.recover?.(
      {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/plan-refine-prd.json",
      },
      ctx,
    );

    expect(result).not.toBeNull();
    expect(result?.feature).toBe("checkout-flow");
    expect(result?.branchName).toBe("feat/checkout");
    expect(result?.userStories).toHaveLength(1);
  });

  test("returns null when the output file contains invalid JSON", async () => {
    const mod = await import("@/operations");
    const { planRefineOp } = mod;
    const runtime = makeTestRuntime();
    createdRuntimes.push(runtime);
    const view = runtime.packages.repo();
    const ctx: VerifyContext<unknown> = {
      packageView: view,
      config: view.select(planInteractiveOp.config),
      readFile: async () => "not valid json {",
      fileExists: async () => true,
    };

    const result = await planRefineOp.recover?.(
      {
        specContent: "Build a checkout flow",
        codebaseContext: "Existing app context",
        featureName: "checkout-flow",
        branchName: "feat/checkout",
        outputPath: "/tmp/bad-prd.json",
      },
      ctx,
    );

    expect(result).toBeNull();
  });
});
