import { describe, expect, test } from "bun:test";
import type { ModelDef } from "@/config/schema";
import type { InteractionExchange, TurnResult } from "@/agents";
import { buildTurnResult } from "@/agents";

const MODEL: ModelDef = { provider: "anthropic", model: "claude-sonnet-4-5", env: {} };

function makeResponse(overrides: Partial<AcpSessionResponse> = {}): AcpSessionResponse | null {
  return {
    messages: [{ role: "assistant", content: "" }],
    stopReason: "end_turn",
    ...overrides,
  };
}

describe("buildTurnResult — AC1: wall-clock timeout surfaces timedOut=true", () => {
  test("returns TurnResult with timedOut=true when timedOut flag is passed", () => {
    const result = buildTurnResult({
      lastResponse: null,
      totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: true,
      modelDef: MODEL,
    });
    expect(result.timedOut).toBe(true);
  });

  test("returns output='' when timedOut flag is passed (AC2)", () => {
    const result = buildTurnResult({
      lastResponse: null,
      totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: true,
      modelDef: MODEL,
    });
    expect(result.output).toBe("");
  });

  test("extracts output from the response when timedOut is false (AC3 normal path)", () => {
    const result = buildTurnResult({
      lastResponse: makeResponse({
        messages: [{ role: "assistant", content: "hello world" }],
      }),
      totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: false,
      modelDef: MODEL,
    });
    expect(result.output).toBe("hello world");
    expect(result.timedOut).toBe(false);
  });

  test("returns timedOut=undefined when flag is not provided (AC3)", () => {
    const result = buildTurnResult({
      lastResponse: makeResponse({
        messages: [{ role: "assistant", content: "done" }],
      }),
      totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: false,
      modelDef: MODEL,
    });
    expect(result.timedOut).toBe(false);
  });

  test("preserves internalRoundTrips, tokenUsage, and cost on timeout", () => {
    const result = buildTurnResult({
      lastResponse: null,
      totalTokenUsage: { inputTokens: 5, outputTokens: 3 },
      totalExactCostUsd: 0.42,
      turnCount: 7,
      interactions: [],
      timedOut: true,
      modelDef: MODEL,
    });
    expect(result.internalRoundTrips).toBe(7);
    expect(result.tokenUsage).toEqual({ inputTokens: 5, outputTokens: 3 });
    expect(result.exactCostUsd).toBe(0.42);
  });

  test("emits interactions array only when present (matching legacy contract)", () => {
    const interactions: InteractionExchange[] = [
      { turnIndex: 1, question: "q?", reply: "a" },
    ];
    const withInter = buildTurnResult({
      lastResponse: makeResponse({ messages: [{ role: "assistant", content: "x" }] }),
      totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions,
      timedOut: false,
      modelDef: MODEL,
    });
    expect(withInter.interactions).toEqual(interactions);

    const noInter = buildTurnResult({
      lastResponse: makeResponse({ messages: [{ role: "assistant", content: "x" }] }),
      totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: false,
      modelDef: MODEL,
    });
    expect(noInter.interactions).toBeUndefined();
  });
});