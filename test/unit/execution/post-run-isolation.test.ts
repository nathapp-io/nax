import { describe, expect, test } from "bun:test";
import { makeTestContext } from "@test/helpers";
import type { IsolationCheck } from "@/execution/types";
import type { PipelineContext } from "@/pipeline/types";

/** PipelineContext plus the isolation bag applyPostRunInspection writes onto ctx. */
type IsolationCtx = PipelineContext & { tddIsolations?: Record<string, IsolationCheck> };

describe("applyPostRunInspection — isolation aggregation", () => {
  test("collects isolation from TDD phase outputs into ctx.tddIsolations", async () => {
    const { applyPostRunInspection } = await import("@/execution");

    // Minimal ctx — only what applyPostRunInspection reads
    const ctx: IsolationCtx = makeTestContext({
      workdir: "/tmp/x",
      routing: {
        complexity: "simple",
        modelTier: "balanced",
        testStrategy: "three-session-tdd",
        reasoning: "",
      },
    });

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

    await applyPostRunInspection(ctx, planResult, {
      capturedTokenUsage: undefined,
      capturedResponse: "",
      capturedCostUsd: 0,
      tddMode: { isLite: false, rollbackEnabled: false },
      initialRef: "abc",
      untrackedBefore: null,
    });

    expect(ctx.tddIsolations).toBeDefined();
    expect(ctx.tddIsolations?.["test-writer"]?.passed).toBe(true);
    expect(ctx.tddIsolations?.implementer?.passed).toBe(true);
    // verifier has no isolation — should not appear
    expect(ctx.tddIsolations?.verifier).toBeUndefined();
  });

  test("does not set tddIsolations when no phase has isolation", async () => {
    const { applyPostRunInspection } = await import("@/execution");

    const ctx: IsolationCtx = makeTestContext({
      workdir: "/tmp/x",
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "",
      },
    });

    const planResult = {
      success: true,
      durationMs: 100,
      phaseOutputs: {
        implementer: { success: true, filesChanged: ["src/a.ts"] },
      },
      phaseCosts: { implementer: 0 },
      totalCostUsd: 0,
    };

    await applyPostRunInspection(ctx, planResult, {
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
