// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { makeDispatchContext } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { PipelineContext, PipelineStage } from "@/pipeline";
import { MAX_STAGE_RETRIES, runPipeline } from "@/pipeline";

function makeCtx(): PipelineContext {
  return {
    config: DEFAULT_CONFIG,
    rootConfig: DEFAULT_CONFIG,
    prd: { stories: [], acceptanceOverrides: {} } as any,
    story: { id: "US-001", title: "t", status: "pending", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    projectDir: "/tmp",
    workdir: "/tmp",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
  };
}

function stage(
  name: string,
  action: () => import("@/pipeline").StageResult | Promise<import("@/pipeline").StageResult>,
): PipelineStage {
  return { name, enabled: () => true, execute: async () => action() };
}

describe("runPipeline retry action", () => {
  test("retry jumps back to named stage", async () => {
    const order: string[] = [];
    let attempt = 0;

    const stages = [
      stage("a", () => {
        order.push("a");
        return { action: "continue" };
      }),
      stage("b", () => {
        order.push("b");
        return { action: "continue" };
      }),
      stage("c", () => {
        order.push("c");
        attempt++;
        if (attempt < 2) return { action: "retry", fromStage: "b" };
        return { action: "continue" };
      }),
      stage("d", () => {
        order.push("d");
        return { action: "continue" };
      }),
    ];

    const result = await runPipeline(stages, makeCtx());

    expect(result.finalAction).toBe("complete");
    expect(order).toEqual(["a", "b", "c", "b", "c", "d"]);
  });

  test("retry escalates after MAX_STAGE_RETRIES exceeded", async () => {
    let calls = 0;
    const stages = [
      stage("verify", () => {
        return { action: "continue" };
      }),
      stage("rectify", () => {
        calls++;
        return { action: "retry", fromStage: "verify" };
      }),
    ];

    const result = await runPipeline(stages, makeCtx());

    expect(result.finalAction).toBe("escalate");
    expect(calls).toBe(MAX_STAGE_RETRIES + 1);
    expect(result.reason).toContain("exceeded max retries");
  });

  test("resetRetryCount resets counter so fixer gets fresh budget after success", async () => {
    // Scenario: rectify uses up MAX_STAGE_RETRIES-1 failed retries (counter at
    // MAX_STAGE_RETRIES-1), then on the next call signals success via
    // resetRetryCount:true. Without the reset, the subsequent verify retry would
    // push the counter to MAX_STAGE_RETRIES+1 and escalate. With the reset it
    // starts from 0, so the pipeline can complete.
    let rectifyCalls = 0;

    const stages = [
      stage("verify", () => ({ action: "continue" })),
      stage("rectify", () => {
        rectifyCalls++;
        if (rectifyCalls === MAX_STAGE_RETRIES) {
          // Successful fix on the MAX_STAGE_RETRIES-th call — reset counter
          return { action: "retry", fromStage: "verify", resetRetryCount: true };
        }
        if (rectifyCalls > MAX_STAGE_RETRIES) {
          // After reset verify ran successfully; rectify is done
          return { action: "continue" };
        }
        return { action: "retry", fromStage: "verify" };
      }),
    ];

    // Flow: verify+rectify cycle MAX_STAGE_RETRIES times (counter hits max without
    // reset). On the MAX_STAGE_RETRIES-th rectify call, counter is reset → verify
    // retries cleanly → rectify returns continue → pipeline completes.
    const result = await runPipeline(stages, makeCtx());
    expect(result.finalAction).toBe("complete");
    expect(rectifyCalls).toBe(MAX_STAGE_RETRIES + 1);
  });

  test("retry to unknown stage escalates", async () => {
    const stages = [stage("a", () => ({ action: "retry", fromStage: "nonexistent" }))];

    const result = await runPipeline(stages, makeCtx());
    expect(result.finalAction).toBe("escalate");
    expect(result.reason).toContain("not found");
  });

  test("resetRetryCount resets counter so fixer gets fresh budget after success", async () => {
    // Scenario: rectify uses up MAX_STAGE_RETRIES-1 failed retries (counter at
    // MAX_STAGE_RETRIES-1), then on the next call signals success via
    // resetRetryCount:true. Without the reset, the subsequent verify retry would
    // push the counter to MAX_STAGE_RETRIES+1 and escalate. With the reset it
    // starts from 0, so the pipeline can complete.
    let rectifyCalls = 0;

    const stages = [
      stage("verify", () => ({ action: "continue" })),
      stage("rectify", () => {
        rectifyCalls++;
        if (rectifyCalls === MAX_STAGE_RETRIES) {
          // Successful fix on the MAX_STAGE_RETRIES-th call — reset counter
          return { action: "retry", fromStage: "verify", resetRetryCount: true };
        }
        if (rectifyCalls > MAX_STAGE_RETRIES) {
          // After reset verify ran successfully; rectify is done
          return { action: "continue" };
        }
        return { action: "retry", fromStage: "verify" };
      }),
    ];

    // Flow: verify+rectify cycle MAX_STAGE_RETRIES times (counter hits max without
    // reset). On the MAX_STAGE_RETRIES-th rectify call, counter is reset → verify
    // retries cleanly → rectify returns continue → pipeline completes.
    const result = await runPipeline(stages, makeCtx());
    expect(result.finalAction).toBe("complete");
    expect(rectifyCalls).toBe(MAX_STAGE_RETRIES + 1);
  });

  test("disabled stages are skipped during retry", async () => {
    const order: string[] = [];
    let attempt = 0;

    const stages = [
      stage("verify", () => {
        order.push("verify");
        return { action: "continue" };
      }),
      {
        name: "disabled",
        enabled: () => false,
        execute: async () => {
          order.push("disabled");
          return { action: "continue" as const };
        },
      },
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
