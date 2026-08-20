/**
 * Tests for cost/calculate.ts — addTokenUsage (Issue 708 Phase A)
 *
 * Covers:
 * - Basic addition of input/output tokens
 * - Addition when one side has undefined cache fields
 * - Addition when both sides have cache fields
 * - Zero preservation behavior (optional fields stay omitted when both undefined)
 * - Defined zero values are preserved in output
 */

import { describe, expect, test } from "bun:test";
import { addTokenUsage, estimateCostFromTokenUsage, resolvePricingSource } from "@/agents/cost";
import type { TokenUsage } from "@/agents/cost";

describe("addTokenUsage", () => {
  test("adds input and output tokens", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(125);
  });

  test("omits cache fields when both operands have them undefined", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBeUndefined();
    expect(result.cacheCreationInputTokens).toBeUndefined();
  });

  test("includes cache fields when one operand has them defined", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBe(10);
    expect(result.cacheCreationInputTokens).toBeUndefined();
  });

  test("sums cache fields when both operands have them defined", () => {
    const a: TokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
    };
    const b: TokenUsage = {
      inputTokens: 200,
      outputTokens: 75,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 15,
    };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBe(30);
    expect(result.cacheCreationInputTokens).toBe(20);
  });

  test("preserves defined zero values in output", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0 };
    const b: TokenUsage = { inputTokens: 200, outputTokens: 75 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBe(0);
  });

  test("returns zero totals when both operands are zero", () => {
    const a: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const b: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const result = addTokenUsage(a, b);

    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.cacheReadInputTokens).toBeUndefined();
    expect(result.cacheCreationInputTokens).toBeUndefined();
  });
});

// ─── BUG-10: defense in depth against non-numeric operands ──────────────────
//
// addTokenUsage is a pure function reachable from upstream wire parsing (acpx
// -> parser.ts -> token-mapper.ts). If a malformed value ever slips past those
// guards, `+` on a string operand silently does concatenation ("123" + 100 ->
// "123100") instead of numeric addition, corrupting the running total and
// eventually producing "$NaN" costs. This block asserts the function is
// robust on its own, independent of whether upstream guards hold.
describe("addTokenUsage — BUG-10 malformed operand guard", () => {
  test("a string inputTokens does not trigger string concatenation", () => {
    // Deliberately violating the TokenUsage contract to simulate a value that
    // slipped past upstream numeric guards.
    const a = { inputTokens: "123", outputTokens: 50 } as unknown as TokenUsage; // test-ratchet-allow: as-unknown-as
    const b: TokenUsage = { inputTokens: 100, outputTokens: 25 };
    const result = addTokenUsage(a, b);

    expect(result.inputTokens).toBe(100);
    expect(typeof result.inputTokens).toBe("number");
  });

  test("a string outputTokens does not trigger string concatenation", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 25 };
    const b = { inputTokens: 50, outputTokens: "75" } as unknown as TokenUsage; // test-ratchet-allow: as-unknown-as
    const result = addTokenUsage(a, b);

    expect(result.outputTokens).toBe(25);
    expect(typeof result.outputTokens).toBe("number");
  });

  test("a non-finite operand (NaN) does not propagate NaN into the total", () => {
    const a: TokenUsage = { inputTokens: Number.NaN, outputTokens: 50 };
    const b: TokenUsage = { inputTokens: 100, outputTokens: 25 };
    const result = addTokenUsage(a, b);

    expect(Number.isFinite(result.inputTokens)).toBe(true);
    expect(result.inputTokens).toBe(100);
  });

  // BUG-58: cacheReadInputTokens/cacheCreationInputTokens must get the same
  // malformed-operand guard as inputTokens/outputTokens — previously they were
  // summed with a bare `+`, reachable to the exact string-concat/NaN corruption
  // this whole describe block exists to prevent.
  test("a string cacheReadInputTokens does not trigger string concatenation", () => {
    const a = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: "123" } as unknown as TokenUsage; // test-ratchet-allow: as-unknown-as
    const b: TokenUsage = { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 10 };
    const result = addTokenUsage(a, b);

    expect(result.cacheReadInputTokens).toBe(10);
    expect(typeof result.cacheReadInputTokens).toBe("number");
  });

  test("a string cacheCreationInputTokens does not trigger string concatenation", () => {
    const a: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 7 };
    const b = { inputTokens: 5, outputTokens: 2, cacheCreationInputTokens: "50" } as unknown as TokenUsage; // test-ratchet-allow: as-unknown-as
    const result = addTokenUsage(a, b);

    expect(result.cacheCreationInputTokens).toBe(7);
    expect(typeof result.cacheCreationInputTokens).toBe("number");
  });

  test("a non-finite cacheReadInputTokens (NaN) does not propagate NaN into the total", () => {
    const a: TokenUsage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: Number.NaN };
    const b: TokenUsage = { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 20 };
    const result = addTokenUsage(a, b);

    expect(Number.isFinite(result.cacheReadInputTokens)).toBe(true);
    expect(result.cacheReadInputTokens).toBe(20);
  });
});

// ─── resolvePricingSource (#1433) ────────────────────────────────────────────

describe("resolvePricingSource", () => {
  test.each([
    ["haiku", "model-rates"],
    ["sonnet", "model-rates"],
    ["claude-haiku-4-5", "model-rates"],
    // Real July models with no MODEL_PRICING entry.
    ["minimax/MiniMax-M2.7", "fallback-rates"],
    ["gpt-5.6-luna[medium]", "fallback-rates"],
  ])("%s resolves to %s", (model, expected) => {
    expect(resolvePricingSource(model)).toBe(expected);
  });

  test.each([[undefined], [""], ["unknown"]])("%p resolves to unknown-model", (model) => {
    expect(resolvePricingSource(model as string | undefined)).toBe("unknown-model");
  });

  test("agrees with the estimator about which models use the generic card", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    // The generic card is $3/$15 per 1M. A model reported as fallback-rates must
    // price exactly there; one reported as model-rates must not (haiku is $0.8/$4).
    expect(resolvePricingSource("minimax/MiniMax-M2.7")).toBe("fallback-rates");
    expect(estimateCostFromTokenUsage(usage, "minimax/MiniMax-M2.7")).toBeCloseTo(18, 5);

    expect(resolvePricingSource("haiku")).toBe("model-rates");
    expect(estimateCostFromTokenUsage(usage, "haiku")).toBeCloseTo(4.8, 5);
  });
});

// ─── #1464: effort-suffix normalization before the rate-card lookup ─────────
//
// nax profiles name codex models with a reasoning-effort suffix, e.g.
// "claude-sonnet-4[high]". Both pricing functions must decompose that suffix
// via parseModelSpec before keying MODEL_PRICING, so a rate card added for
// the bare model id actually takes effect.

describe("effort-suffix normalization (#1464)", () => {
  test("estimateCostFromTokenUsage prices a suffixed model identically to its bare id", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const bare = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    const suffixed = estimateCostFromTokenUsage(usage, "claude-sonnet-4[high]");
    expect(suffixed).toBeCloseTo(bare, 10);
  });

  test("a suffixed known model prices differently from a suffixed unpriced model", () => {
    // haiku ($0.8/$4 per 1M) diverges from the generic fallback card ($3/$15
    // per 1M) — unlike claude-sonnet-4, which happens to match it, so this
    // proves the real rate card was hit rather than the fallback.
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const known = estimateCostFromTokenUsage(usage, "haiku[high]");
    const unpriced = estimateCostFromTokenUsage(usage, "totally-unknown-model[high]");
    expect(known).not.toBeCloseTo(unpriced, 5);
  });

  test("resolvePricingSource reports model-rates for a suffixed known model", () => {
    expect(resolvePricingSource("claude-sonnet-4[high]")).toBe("model-rates");
  });

  test("resolvePricingSource still reports unknown-model for undefined, empty, and 'unknown'", () => {
    expect(resolvePricingSource(undefined)).toBe("unknown-model");
    expect(resolvePricingSource("")).toBe("unknown-model");
    expect(resolvePricingSource("unknown")).toBe("unknown-model");
  });

  test("resolvePricingSource reports fallback-rates for a genuinely unknown model, suffixed or not", () => {
    expect(resolvePricingSource("totally-unknown-model")).toBe("fallback-rates");
    expect(resolvePricingSource("totally-unknown-model[high]")).toBe("fallback-rates");
  });

  // The defect behind #1464's placement decision was these two DISAGREEING: the
  // number is priced upstream at the adapter from the raw spec, the label is
  // resolved downstream in the cost middleware. Normalizing in only one of them
  // yields a row claiming `model-rates` over a number built on the generic card.
  // Asserting each half separately cannot catch that — this binds them.
  test("a model reported as model-rates is genuinely NOT priced on the fallback card", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const fallbackPrice = estimateCostFromTokenUsage(usage, "totally-unknown-model");

    for (const model of ["haiku[high]", "haiku", "opus[medium]"]) {
      expect(resolvePricingSource(model)).toBe("model-rates");
      expect(estimateCostFromTokenUsage(usage, model)).not.toBeCloseTo(fallbackPrice, 5);
    }
  });
});
