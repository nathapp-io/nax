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
import type { CostEstimate, TokenUsage } from "@/agents/cost";
import { addTokenUsage, formatCostWithConfidence, inputClassTokens, resolvePricingSource } from "@/agents/cost";

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
//
// US-003 AC1: returns "unknown-model" when the model argument is undefined,
// empty, or the literal "unknown".
// US-003 AC2: returns "fallback-rates" for any non-empty, non-undefined,
// non-"unknown" model name. After US-003 the table-backed
// `MODEL_PRICING[model]` lookup is gone — every producer without a
// `pricingSource` of its own (i.e. ACP) is now uniformly a fallback,
// because there is no longer a table to be a hit against.

describe("resolvePricingSource", () => {
  // US-003 AC1
  test("[AC1] returns unknown-model when model is undefined", () => {
    expect(resolvePricingSource(undefined)).toBe("unknown-model");
  });

  // US-003 AC1
  test("[AC1] returns unknown-model when model is empty", () => {
    expect(resolvePricingSource("")).toBe("unknown-model");
  });

  // US-003 AC1
  test('[AC1] returns unknown-model when model is the literal "unknown"', () => {
    expect(resolvePricingSource("unknown")).toBe("unknown-model");
  });

  // US-003 AC2
  test("[AC2] returns fallback-rates for a non-empty resolved model name", () => {
    expect(resolvePricingSource("haiku")).toBe("fallback-rates");
  });

  // US-003 AC2 — any name that USED to be a model-rates hit now falls back.
  // The named anchors are deliberately from the deleted table, so the test
  // fails before the table is removed (proves the contract change) and passes
  // after it is (proves the contract holds).
  test.each([
    ["sonnet"],
    ["haiku"],
    ["opus"],
    ["claude-sonnet-4"],
    ["claude-sonnet-4-5"],
    ["claude-haiku-4-5"],
    ["claude-opus-4"],
    ["gpt-4.1"],
    ["gpt-5.6-luna"],
    ["gpt-5.6-terra"],
    ["minimax/MiniMax-M3"],
    ["gemini-2.5-pro"],
    ["opencode-go/deepseek-v4-pro"],
  ])("[AC2] %s resolves to fallback-rates after the MODEL_PRICING branch is removed", (model) => {
    expect(resolvePricingSource(model)).toBe("fallback-rates");
  });

  // US-003 AC2 — preserves #1464 suffix-stripping semantics. Any
  // non-empty/non-"unknown" bare id the catalog-derived path would have
  // resolved falls through to fallback-rates now that the table is gone.
  test("[AC2] returns fallback-rates for a suffixed resolved model name", () => {
    expect(resolvePricingSource("claude-sonnet-4[high]")).toBe("fallback-rates");
    expect(resolvePricingSource("haiku[medium]")).toBe("fallback-rates");
    expect(resolvePricingSource("gpt-5.6-luna[high]")).toBe("fallback-rates");
  });

  test("still admits the full five-value return union for producer-supplied callers", () => {
    // The US-004 widening admitted "catalog-rates" and "config-override" so
    // the producer's report on CompleteResult / TurnResult type-checks
    // through the cost subscriber unchanged. This function does not return
    // those values itself — it serves callers with no producer-supplied
    // source — but the union must still admit them.
    const result: ReturnType<typeof resolvePricingSource> = "unknown-model";
    expect(["model-rates", "fallback-rates", "unknown-model", "catalog-rates", "config-override"]).toContain(result);
  });
});

describe("inputClassTokens", () => {
  test("sums input with cache reads and cache writes", () => {
    expect(
      inputClassTokens({
        inputTokens: 16,
        outputTokens: 900,
        cacheReadInputTokens: 71_755,
        cacheCreationInputTokens: 12_368,
      }),
    ).toBe(84_139);
  });

  test("treats absent cache fields as zero", () => {
    expect(inputClassTokens({ inputTokens: 500, outputTokens: 900 })).toBe(500);
  });

  test("excludes output tokens", () => {
    // Output is never part of the prompt the provider charged for. Asserted
    // explicitly because nax-ai's totalTokens() does include it, and reaching
    // for that helper here would double-count against the trailing estimate.
    expect(inputClassTokens({ inputTokens: 10, outputTokens: 10_000 })).toBe(10);
  });
});

// ─── formatCostWithConfidence (moved from test/unit/metrics/cost.test.ts) ───
//
// US-003 deletes test/unit/metrics/cost.test.ts (its estimateCost /
// estimateCostByDuration / COST_RATES surface is gone). The
// formatCostWithConfidence coverage it carried moves to this suite; the
// function itself lives in calculate.ts and is unchanged.

describe("formatCostWithConfidence", () => {
  test.each([
    ["exact confidence without prefix", { cost: 0.12, confidence: "exact" }, "$0.12"],
    ["estimated confidence with tilde prefix", { cost: 0.15, confidence: "estimated" }, "~$0.15"],
    ["fallback confidence with tilde and label", { cost: 0.05, confidence: "fallback" }, "~$0.05 (duration-based)"],
  ] as const)("formats %s", (_label, estimate, expected) => {
    expect(formatCostWithConfidence(estimate)).toBe(expected);
  });

  test("formats very small costs correctly", () => {
    const estimate: CostEstimate = { cost: 0.001, confidence: "exact" };
    expect(formatCostWithConfidence(estimate)).toBe("$0.00");
  });

  test("formats large costs correctly", () => {
    const estimate: CostEstimate = { cost: 12.345, confidence: "estimated" };
    expect(formatCostWithConfidence(estimate)).toBe("~$12.35");
  });
});
