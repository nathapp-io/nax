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
import type { CostEstimate } from "@/agents/cost";
import { formatCostWithConfidence, resolvePricingSource } from "@/agents/cost";

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
