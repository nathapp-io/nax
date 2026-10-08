import { describe, expect, test } from "bun:test";
import { attachTurnSpend } from "@nathapp/nax-agent";
import { addSpend, failedSpendFields, NO_SPEND, spendOfError, spendOfResult } from "@/agents/acp/pricing";
import { FALLBACK_RATES } from "@/agents/cost";

const CARD = { rates: FALLBACK_RATES, source: "fallback-rates" } as const;

describe("acp pricing (S4b spec §7.3)", () => {
  test("a reported cost becomes exactCostUsd", () => {
    const spend = spendOfResult({
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.01,
      costSource: "reported",
    });
    expect(spend).toEqual({ tokenUsage: { inputTokens: 10, outputTokens: 5 }, exactCostUsd: 0.01 });
  });

  test("an unpriced turn has no exactCostUsd", () => {
    const spend = spendOfResult({
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0,
      costSource: "unpriced",
    });
    expect(spend.exactCostUsd).toBeUndefined();
  });

  test("a failed turn's attached spend is read; none attached is zero", () => {
    const err = new Error("boom");
    attachTurnSpend(err, { tokenUsage: { inputTokens: 3, outputTokens: 1 }, costUsd: 0.002, costSource: "reported" });
    expect(spendOfError(err)).toEqual({ tokenUsage: { inputTokens: 3, outputTokens: 1 }, exactCostUsd: 0.002 });
    expect(spendOfError(new Error("bare"))).toEqual(NO_SPEND);
    expect(spendOfError("not an object")).toEqual(NO_SPEND);
  });

  test("addSpend sums tokens, and exact cost only once some turn reported one", () => {
    const priced = { tokenUsage: { inputTokens: 10, outputTokens: 5 }, exactCostUsd: 0.01 };
    const unpriced = { tokenUsage: { inputTokens: 1, outputTokens: 1 }, exactCostUsd: undefined };
    expect(addSpend(NO_SPEND, unpriced).exactCostUsd).toBeUndefined();
    const total = addSpend(addSpend(NO_SPEND, priced), unpriced);
    expect(total.tokenUsage).toMatchObject({ inputTokens: 11, outputTokens: 6 });
    expect(total.exactCostUsd).toBeCloseTo(0.01);
  });

  test("failedSpendFields prices tokens from the card and keeps the reported cost (BUG-57)", () => {
    const fields = failedSpendFields(
      { tokenUsage: { inputTokens: 1_000_000, outputTokens: 0 }, exactCostUsd: 2 },
      CARD,
    );
    expect(fields.estimatedCostUsd).toBeCloseTo(3);
    expect(fields.exactCostUsd).toBe(2);
    expect(fields.pricingSource).toBe("fallback-rates");
    expect(failedSpendFields(NO_SPEND, CARD).estimatedCostUsd).toBe(0);
  });
});
