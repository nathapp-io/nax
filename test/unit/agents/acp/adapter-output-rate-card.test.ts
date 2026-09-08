/**
 * US-002 — `BuildTurnResultInput.rateCard` replaces `modelDef` (the field this
 * story removes). `buildTurnResult` must price from `rateCard.rates` and stamp
 * `rateCard.source` onto `pricingSource` on the returned `TurnResult`.
 *
 * AC5: buildTurnResult with rateCard inputPer1M=2 outputPer1M=10 and 1M+1M tokens
 *      returns estimatedCostUsd = 12.
 * AC6: buildTurnResult with totalExactCostUsd=0.42 returns exactCostUsd=0.42
 *      unchanged regardless of the rate card.
 * AC8: buildTurnResult with timedOut=true returns output='' regardless of rateCard.
 *
 * Stub note: `buildTurnResult` in this branch returns `estimatedCostUsd: 0`
 * and never sets `pricingSource`. AC5 fails on the cost value; AC6 / AC8 pass
 * because the field passthrough and `timedOut` short-circuit are already
 * preserved by the stub.
 */

import { describe, expect, test } from "bun:test";
import type { AcpSessionResponse } from "@/agents";
import { buildTurnResult } from "@/agents";
import type { RateCard } from "@/agents/cost";

function makeResponse(overrides: Partial<AcpSessionResponse> = {}): AcpSessionResponse {
  return {
    messages: [{ role: "assistant", content: "" }],
    stopReason: "end_turn",
    ...overrides,
  };
}

describe("buildTurnResult — rateCard field", () => {
  // AC5 (success): with a catalog-rates card priced at 2/10, 1M input + 1M
  // output tokens is exactly $12. The stub returns `estimatedCostUsd: 0`,
  // so this assertion fails until `buildTurnResult` actually reads the
  // card's rates.
  test("AC5: rateCard inputPer1M=2 outputPer1M=10 with 1M+1M tokens returns estimatedCostUsd=12", () => {
    const card: RateCard = {
      rates: { inputPer1M: 2, outputPer1M: 10 },
      source: "catalog-rates",
    };
    const result = buildTurnResult({
      lastResponse: makeResponse(),
      totalTokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: false,
      rateCard: card,
    });
    expect(result.estimatedCostUsd).toBe(12);
  });

  // AC5 boundary: the same rate card with zero tokens is still $0 — guards
  // against an implementer accidentally returning a non-zero cost when no
  // tokens were burned (the pre-story path did this via
  // `totalTokenUsage.inputTokens > 0 || totalTokenUsage.outputTokens > 0`).
  test("AC5 boundary: zero tokens with rateCard returns estimatedCostUsd=0", () => {
    const card: RateCard = {
      rates: { inputPer1M: 2, outputPer1M: 10 },
      source: "catalog-rates",
    };
    const result = buildTurnResult({
      lastResponse: makeResponse(),
      totalTokenUsage: { inputTokens: 0, outputTokens: 0 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: false,
      rateCard: card,
    });
    expect(result.estimatedCostUsd).toBe(0);
  });

  // AC6 (success): a wire-reported exactCostUsd is preserved regardless of
  // what the rate card says — the rate card governs `estimatedCostUsd`,
  // not `exactCostUsd`. The stub already preserves the field, so this
  // passes; the boundary below pins down that a non-matching card doesn't
  // overwrite it.
  test("AC6: totalExactCostUsd=0.42 returns exactCostUsd=0.42 unchanged", () => {
    const card: RateCard = {
      rates: { inputPer1M: 3, outputPer1M: 15 },
      source: "catalog-rates",
    };
    const result = buildTurnResult({
      lastResponse: makeResponse(),
      totalTokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      totalExactCostUsd: 0.42,
      turnCount: 1,
      interactions: [],
      timedOut: false,
      rateCard: card,
    });
    expect(result.exactCostUsd).toBe(0.42);
  });

  // AC6 boundary: a fallback-rates card does not alter a wire-reported
  // exactCostUsd. Different source / different rates — same exactCostUsd
  // pass-through.
  test("AC6 boundary: exactCostUsd is preserved when the card is fallback-rates", () => {
    const card: RateCard = {
      rates: { inputPer1M: 3, outputPer1M: 15 },
      source: "fallback-rates",
    };
    const result = buildTurnResult({
      lastResponse: makeResponse(),
      totalTokenUsage: { inputTokens: 5_000_000, outputTokens: 2_000_000 },
      totalExactCostUsd: 0.42,
      turnCount: 2,
      interactions: [],
      timedOut: false,
      rateCard: card,
    });
    expect(result.exactCostUsd).toBe(0.42);
  });

  // AC6 boundary: when wire never reported an exact cost, the field stays
  // undefined (not 0) so downstream consumers can tell "no wire report"
  // from "wire reported zero".
  test("AC6 boundary: undefined totalExactCostUsd leaves exactCostUsd undefined", () => {
    const card: RateCard = {
      rates: { inputPer1M: 3, outputPer1M: 15 },
      source: "catalog-rates",
    };
    const result = buildTurnResult({
      lastResponse: makeResponse(),
      totalTokenUsage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: false,
      rateCard: card,
    });
    expect(result.exactCostUsd).toBeUndefined();
  });

  // AC8 (success): `timedOut=true` forces `output=""` regardless of any
  // leftover `lastResponse`. The stub preserves this; AC8 is the
  // regression guard so the rate-card migration does not regress the
  // timeout transport fact.
  test("AC8: timedOut=true returns output='' even when lastResponse carries content", () => {
    const card: RateCard = {
      rates: { inputPer1M: 3, outputPer1M: 15 },
      source: "catalog-rates",
    };
    const result = buildTurnResult({
      lastResponse: makeResponse({
        messages: [{ role: "assistant", content: "this should not leak" }],
      }),
      totalTokenUsage: { inputTokens: 5, outputTokens: 3 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: true,
      rateCard: card,
    });
    expect(result.output).toBe("");
    expect(result.timedOut).toBe(true);
  });

  // AC8 boundary: `timedOut=false` does not blank the output — the
  // extraction still happens. Pinned because the rate-card change is the
  // easiest place to accidentally re-introduce the always-blank
  // regression.
  test("AC8 boundary: timedOut=false preserves extracted assistant content", () => {
    const card: RateCard = {
      rates: { inputPer1M: 3, outputPer1M: 15 },
      source: "catalog-rates",
    };
    const result = buildTurnResult({
      lastResponse: makeResponse({
        messages: [{ role: "assistant", content: "real output" }],
      }),
      totalTokenUsage: { inputTokens: 1, outputTokens: 1 },
      totalExactCostUsd: undefined,
      turnCount: 1,
      interactions: [],
      timedOut: false,
      rateCard: card,
    });
    expect(result.output).toBe("real output");
  });
});
