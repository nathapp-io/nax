import { describe, expect, test } from "bun:test";
import type { TurnResult } from "@/agents/types";
// Leaf import: `normalizeHopOutput` is deliberately NOT on the @/operations
// barrel (only the two classifiers are), so import it from its own module.
import { normalizeHopOutput } from "@/operations/call-hop-output";

function makeTurn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    output: "",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    internalRoundTrips: 1,
    ...overrides,
  };
}

const ctx = {
  storyId: "US-002",
  opName: "verifier",
  dispatchAgent: "native",
  fileOutputPath: undefined,
  readFileOutput: async () => null,
};

describe("normalizeHopOutput — spin-stopped turns", () => {
  test("classifies a spin-stopped turn as fail-spin even when it carries prose", async () => {
    const turn = makeTurn({
      output: "I re-ran the tests and they pass. Let me check once more.",
      spinStopped: true,
      turnIncomplete: true,
    });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-spin");
    expect(result.adapterFailure?.retriable).toBe(true);
    expect(result.adapterFailure?.category).toBe("quality");
  });

  test("leaves a producer's own adapterFailure untouched", async () => {
    const turn = makeTurn({
      output: "prose",
      spinStopped: true,
      adapterFailure: { category: "availability", outcome: "fail-quota", retriable: false, message: "out of quota" },
    });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-quota");
  });

  test("does not classify an ordinary completed turn", async () => {
    const result = await normalizeHopOutput(async () => makeTurn({ output: "{}" }), "prompt", ctx);

    expect(result.adapterFailure).toBeUndefined();
  });
});
