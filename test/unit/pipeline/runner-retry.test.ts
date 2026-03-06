// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { MAX_STAGE_RETRIES, runPipeline } from "../../../src/pipeline/runner";
import type { PipelineContext, PipelineStage } from "../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../src/config";

function makeCtx(): PipelineContext {
  return {
    config: DEFAULT_CONFIG,
    prd: { stories: [], acceptanceOverrides: {} } as any,
    story: { id: "US-001", title: "t", status: "pending", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: "/tmp",
    hooks: {},
  };
}

function stage(name: string, action: () => import("../../../src/pipeline/types").StageResult | Promise<import("../../../src/pipeline/types").StageResult>): PipelineStage {
  return { name, enabled: () => true, execute: async () => action() };
}

describe("runPipeline retry action", () => {
  test("retry jumps back to named stage", async () => {
    const order: string[] = [];
    let attempt = 0;

    const stages = [
      stage("a", () => { order.push("a"); return { action: "continue" }; }),
      stage("b", () => { order.push("b"); return { action: "continue" }; }),
      stage("c", () => {
        order.push("c");
        attempt++;
        if (attempt < 2) return { action: "retry", fromStage: "b" };
        return { action: "continue" };
      }),
      stage("d", () => { order.push("d"); return { action: "continue" }; }),
    ];

    const result = await runPipeline(stages, makeCtx());

    expect(result.finalAction).toBe("complete");
    expect(order).toEqual(["a", "b", "c", "b", "c", "d"]);
  });

  test("retry fails after MAX_STAGE_RETRIES exceeded", async () => {
    let calls = 0;
    const stages = [
      stage("verify", () => { return { action: "continue" }; }),
      stage("rectify", () => { calls++; return { action: "retry", fromStage: "verify" }; }),
    ];

    const result = await runPipeline(stages, makeCtx());

    expect(result.finalAction).toBe("fail");
    expect(calls).toBe(MAX_STAGE_RETRIES + 1);
    expect(result.reason).toContain("exceeded max retries");
  });

  test("retry to unknown stage escalates", async () => {
    const stages = [
      stage("a", () => ({ action: "retry", fromStage: "nonexistent" })),
    ];

    const result = await runPipeline(stages, makeCtx());
    expect(result.finalAction).toBe("escalate");
    expect(result.reason).toContain("not found");
  });

  test("disabled stages are skipped during retry", async () => {
    const order: string[] = [];
    let attempt = 0;

    const stages = [
      stage("verify", () => { order.push("verify"); return { action: "continue" }; }),
      { name: "disabled", enabled: () => false, execute: async () => { order.push("disabled"); return { action: "continue" as const }; } },
      stage("rectify", () => {
        order.push("rectify");
        attempt++;
        if (attempt < 2) return { action: "retry", fromStage: "verify" };
        return { action: "continue" };
      }),
    ];

    await runPipeline(stages, makeCtx());
    expect(order).not.toContain("disabled");
    expect(order).toEqual(["verify", "rectify", "verify", "rectify"]);
  });
});
