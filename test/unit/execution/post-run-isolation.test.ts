import { describe, expect, test } from "bun:test";

describe("applyPostRunInspection — isolation aggregation", () => {
  test("collects isolation from TDD phase outputs into ctx.tddIsolations", async () => {
    const { applyPostRunInspection } = await import("@/execution");

    // Minimal ctx — only what applyPostRunInspection reads
    const ctx: any = {
      story: { id: "US-001" },
      workdir: "/tmp/x",
      routing: { testStrategy: "three-session-tdd", modelTier: "balanced" },
      config: {},
    };

    const planResult = {
      success: true,
      durationMs: 100,
      phaseOutputs: {
        "test-writer": {
          success: true,
          filesChanged: ["test/a.test.ts"],
          isolation: { passed: true, violations: [], description: "tw ok" },
        },
        implementer: {
          success: true,
          filesChanged: ["src/a.ts"],
          isolation: { passed: true, violations: [], description: "impl ok" },
        },
        verifier: { success: true, filesChanged: [] },
      },
      phaseCosts: { "test-writer": 0, implementer: 0, verifier: 0 },
      totalCostUsd: 0,
    };

    await applyPostRunInspection(ctx, planResult as any, {
      capturedTokenUsage: undefined,
      capturedResponse: "",
      capturedCostUsd: 0,
      tddMode: { isLite: false, rollbackEnabled: false },
      initialRef: "abc",
      untrackedBefore: null,
    });

    expect(ctx.tddIsolations).toBeDefined();
    expect(ctx.tddIsolations["test-writer"].passed).toBe(true);
    expect(ctx.tddIsolations.implementer.passed).toBe(true);
    // verifier has no isolation — should not appear
    expect(ctx.tddIsolations.verifier).toBeUndefined();
  });

  test("does not set tddIsolations when no phase has isolation", async () => {
    const { applyPostRunInspection } = await import("@/execution");

    const ctx: any = {
      story: { id: "US-001" },
      workdir: "/tmp/x",
      routing: { testStrategy: "direct", modelTier: "fast" },
      config: {},
    };

    const planResult = {
      success: true,
      durationMs: 100,
      phaseOutputs: {
        implementer: { success: true, filesChanged: ["src/a.ts"] },
      },
      phaseCosts: { implementer: 0 },
      totalCostUsd: 0,
    };

    await applyPostRunInspection(ctx, planResult as any, {
      capturedTokenUsage: undefined,
      capturedResponse: "",
      capturedCostUsd: 0,
      tddMode: null,
      initialRef: "abc",
      untrackedBefore: null,
    });

    expect(ctx.tddIsolations).toBeUndefined();
  });
});
