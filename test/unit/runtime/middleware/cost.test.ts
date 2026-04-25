import { describe, test, expect } from "bun:test";
import { costMiddleware } from "../../../../src/runtime/middleware/cost";
import { createNoOpCostAggregator, type CostEvent } from "../../../../src/runtime/cost-aggregator";
import { DEFAULT_CONFIG } from "../../../../src/config";
import type { MiddlewareContext } from "../../../../src/runtime/agent-middleware";

function makeCtx(): MiddlewareContext {
  return {
    runId: "r-001", agentName: "claude", kind: "run",
    request: null, prompt: null, config: DEFAULT_CONFIG,
    resolvedPermissions: { mode: "approve-reads", skipPermissions: false },
    storyId: "s-1", stage: "run",
  };
}

describe("costMiddleware", () => {
  test("after() records CostEvent with correct camelCase token fields", async () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const mw = costMiddleware(agg, "r-001");
    const result = {
      success: true, estimatedCost: 0.005,
      tokenUsage: { inputTokens: 100, outputTokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    };
    await mw.after!(makeCtx(), result, 200);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].costUsd).toBe(0.005);
    expect(recorded[0].tokens.input).toBe(100);
    expect(recorded[0].tokens.output).toBe(50);
    expect(recorded[0].tokens.cacheRead).toBe(10);
    expect(recorded[0].tokens.cacheWrite).toBe(5);
    expect(recorded[0].durationMs).toBe(200);
    expect(recorded[0].storyId).toBe("s-1");
    expect(recorded[0].stage).toBe("run");
  });

  test("after() records CostEvent for complete calls with costUsd but no tokenUsage", async () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const mw = costMiddleware(agg, "r-001");
    const result = { output: "done", costUsd: 0.002, source: "exact" };
    await mw.after!(makeCtx(), result, 150);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].costUsd).toBe(0.002);
    expect(recorded[0].tokens.input).toBe(0);
    expect(recorded[0].tokens.output).toBe(0);
    expect(recorded[0].durationMs).toBe(150);
  });

  test("after() is a no-op when result has no tokenUsage and no costUsd", async () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const mw = costMiddleware(agg, "r-001");
    await mw.after!(makeCtx(), { success: true }, 100);
    expect(recorded).toHaveLength(0);
  });

  test("onError() records CostErrorEvent", async () => {
    const errors: unknown[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: unknown) => errors.push(e) };
    const mw = costMiddleware(agg, "r-001");
    await mw.onError!(makeCtx(), new Error("boom"), 50);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Record<string, unknown>).durationMs).toBe(50);
    expect((errors[0] as Record<string, unknown>).agentName).toBe("claude");
  });
});
