import { describe, expect, test } from "bun:test";
import { addRateTotals, aggregateRates, createRateTotals } from "@/agents/native/session/rate-provenance";

describe("aggregateRates key order (S1-1)", () => {
  test("weighted rates come back in input/output/cacheRead/cacheWrite order", () => {
    const totals = createRateTotals();
    addRateTotals(
      totals,
      { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0 },
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    );
    addRateTotals(
      totals,
      { inputTokens: 300, outputTokens: 30, cacheReadTokens: 150, cacheWriteTokens: 0 },
      { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    );
    const rates = aggregateRates(totals);
    expect(Object.keys(rates ?? {})).toEqual(["input", "output", "cacheRead", "cacheWrite"]);
    expect(rates?.input).toBe(1.5);
    expect(rates?.cacheWrite).toBe(1.25);
  });
});
