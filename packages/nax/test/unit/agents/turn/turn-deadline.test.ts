import { describe, expect, test } from "bun:test";
import { withWarnSpy } from "@test/helpers";
import type { RateCard } from "@/agents/cost";
import { assembleTurnResult, warnWallClockTimeout } from "@/agents/turn/turn-deadline";
import { toPricing } from "@/config/schema-types";

const card: RateCard = { rates: toPricing({ inputPer1M: 2, outputPer1M: 10 }), source: "catalog-rates" };
const base = {
  output: "final text",
  totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
  totalExactCostUsd: undefined,
  turnCount: 1,
  interactions: [],
  timedOut: false,
  rateCard: card,
};

describe("assembleTurnResult", () => {
  test("a timed-out turn returns empty output and timedOut=true", () => {
    const result = assembleTurnResult({ ...base, timedOut: true });
    expect(result.output).toBe("");
    expect(result.timedOut).toBe(true);
  });

  test("zero usage prices nothing: cost 0, rates omitted, source still stamped", () => {
    const result = assembleTurnResult(base);
    expect(result.output).toBe("final text");
    expect(result.estimatedCostUsd).toBe(0);
    expect("rates" in result).toBe(false);
    expect(result.pricingSource).toBe("catalog-rates");
  });

  test("nonzero usage is priced from the card and forwards the rates", () => {
    const result = assembleTurnResult({
      ...base,
      totalTokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    });
    expect(result.estimatedCostUsd).toBeCloseTo(12, 10);
    expect(result.rates?.input).toBe(2);
    expect(result.rates?.output).toBe(10);
  });

  test("exact cost and round trips pass through; interactions only when non-empty", () => {
    const withNone = assembleTurnResult({ ...base, totalExactCostUsd: 0.5, turnCount: 3 });
    expect(withNone.exactCostUsd).toBe(0.5);
    expect(withNone.internalRoundTrips).toBe(3);
    expect("interactions" in withNone).toBe(false);

    const exchange = { turnIndex: 1, question: "q?", reply: "a" };
    expect(assembleTurnResult({ ...base, interactions: [exchange] }).interactions).toEqual([exchange]);
  });
});

describe("warnWallClockTimeout", () => {
  test("logs under the given stage with the session and limit", async () => {
    await withWarnSpy(async (warnSpy) => {
      warnWallClockTimeout("nax-abc-f-s", 600, "acp-adapter");
      expect(warnSpy.mock.calls[0]).toEqual([
        "acp-adapter",
        "wall-clock timeout exceeded — session terminated",
        { sessionName: "nax-abc-f-s", timeoutSeconds: 600 },
      ]);
    });
  });
});
