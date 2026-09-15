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

describe("normalizeHopOutput — transport facts with spinStopped unset (nax#2054)", () => {
  test("classifies a truncated turn with prose as fail-incomplete, not a clean pass", async () => {
    const turn = makeTurn({
      output: "I've implemented the change and verified it works.",
      turnIncomplete: true,
    });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-incomplete");
    expect(result.adapterFailure?.reason).toBe("turn-incomplete");
    expect(result.adapterFailure?.retriable).toBe(true);
  });

  test("classifies a timed-out turn with prose as fail-timeout, not a clean pass", async () => {
    const turn = makeTurn({
      output: "Running the final check now, should be done shortly.",
      timedOut: true,
    });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-timeout");
    expect(result.adapterFailure?.reason).toBe("wall-clock-timeout");
  });

  test("prefers fail-spin over turnIncomplete when both transport facts are set", async () => {
    const turn = makeTurn({
      output: "Re-running the same tool call again.",
      spinStopped: true,
      turnIncomplete: true,
    });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-spin");
  });

  test("leaves a producer's own adapterFailure untouched even with turnIncomplete set", async () => {
    const turn = makeTurn({
      output: "prose",
      turnIncomplete: true,
      adapterFailure: { category: "availability", outcome: "fail-quota", retriable: false, message: "out of quota" },
    });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-quota");
  });

  test("clean prose with no transport fact still runs the provider-refusal check", async () => {
    const turn = makeTurn({ output: "Selected model is at capacity. Please try a different model." });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure?.outcome).toBe("fail-rate-limit");
  });

  test("clean prose with no transport fact and no refusal has no adapterFailure", async () => {
    const turn = makeTurn({ output: "All tests pass." });

    const result = await normalizeHopOutput(async () => turn, "prompt", ctx);

    expect(result.adapterFailure).toBeUndefined();
  });
});
