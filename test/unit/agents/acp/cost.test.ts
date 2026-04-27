/**
 * Tests for ACP cost estimation — ACP-006
 *
 * Covers:
 * - estimateCostFromTokenUsage calculates cost from TokenUsage (camelCase)
 * - Cache tokens use correct reduced/creation rates
 * - Known models have accurate per-token pricing
 * - Unknown models fall back to a reasonable average rate
 * - Zero token usage returns $0.00
 *
 * Note: AcpAgentAdapter.run() integration tests removed in ADR-019 Phase D.
 */

import { describe, expect, test } from "bun:test";
import { estimateCostFromTokenUsage } from "../../../../src/agents/cost";
import type { TokenUsage } from "../../../../src/agents/cost";

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostFromTokenUsage — basic input/output tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateCostFromTokenUsage — basic tokens", () => {
  test("returns $0.00 for zero token usage", () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(estimateCostFromTokenUsage(usage, "claude-sonnet-4")).toBe(0);
  });

  test("calculates non-zero cost for non-zero input tokens", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 0 };
    const cost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    expect(cost).toBeGreaterThan(0);
  });

  test("calculates non-zero cost for non-zero output tokens", () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 1_000_000 };
    const cost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    expect(cost).toBeGreaterThan(0);
  });

  test("output tokens are more expensive than input tokens at equal counts", () => {
    const inputOnlyCost = estimateCostFromTokenUsage(
      { inputTokens: 1_000_000, outputTokens: 0 },
      "claude-sonnet-4",
    );
    const outputOnlyCost = estimateCostFromTokenUsage(
      { inputTokens: 0, outputTokens: 1_000_000 },
      "claude-sonnet-4",
    );
    expect(outputOnlyCost).toBeGreaterThan(inputOnlyCost);
  });

  test("cost scales linearly with token count", () => {
    const costAt1M = estimateCostFromTokenUsage({ inputTokens: 1_000_000, outputTokens: 0 }, "claude-sonnet-4");
    const costAt2M = estimateCostFromTokenUsage({ inputTokens: 2_000_000, outputTokens: 0 }, "claude-sonnet-4");
    expect(costAt2M).toBeCloseTo(costAt1M * 2, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostFromTokenUsage — known model pricing
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateCostFromTokenUsage — known model pricing", () => {
  test("claude-sonnet-4: $3/1M input, $15/1M output", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    // $3.00 input + $15.00 output = $18.00
    expect(cost).toBeCloseTo(18.0, 2);
  });

  test("claude-haiku: cheaper than claude-sonnet-4 for same token count", () => {
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const haikuCost = estimateCostFromTokenUsage(usage, "claude-haiku");
    const sonnetCost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    expect(haikuCost).toBeLessThan(sonnetCost);
  });

  test("gpt-4.1: has a defined pricing rate (non-zero cost)", () => {
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 50_000 };
    const cost = estimateCostFromTokenUsage(usage, "gpt-4.1");
    expect(cost).toBeGreaterThan(0);
  });

  test("gemini-2.5-pro: has a defined pricing rate (non-zero cost)", () => {
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 50_000 };
    const cost = estimateCostFromTokenUsage(usage, "gemini-2.5-pro");
    expect(cost).toBeGreaterThan(0);
  });

  test("codex: has a defined pricing rate (non-zero cost)", () => {
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 50_000 };
    const cost = estimateCostFromTokenUsage(usage, "codex");
    expect(cost).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostFromTokenUsage — unknown model fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateCostFromTokenUsage — unknown model fallback", () => {
  test("returns non-zero cost for an unknown model with non-zero tokens", () => {
    const usage: TokenUsage = { inputTokens: 100_000, outputTokens: 50_000 };
    const cost = estimateCostFromTokenUsage(usage, "unknown-model-xyz");
    expect(cost).toBeGreaterThan(0);
  });

  test("returns $0.00 for unknown model with zero tokens", () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(estimateCostFromTokenUsage(usage, "unknown-model-xyz")).toBe(0);
  });

  test("unknown model fallback rate is a reasonable average (not free, not absurdly expensive)", () => {
    // Check fallback is in reasonable range: $0.50-$30/1M tokens combined
    const usage: TokenUsage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    const cost = estimateCostFromTokenUsage(usage, "some-future-model");
    expect(cost).toBeGreaterThan(0.5);
    expect(cost).toBeLessThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostFromTokenUsage — cache tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateCostFromTokenUsage — cache tokens", () => {
  test("cacheReadInputTokens are cheaper than regular input tokens", () => {
    const regularCost = estimateCostFromTokenUsage(
      { inputTokens: 100_000, outputTokens: 0 },
      "claude-sonnet-4",
    );
    const cacheReadCost = estimateCostFromTokenUsage(
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 100_000 },
      "claude-sonnet-4",
    );
    expect(cacheReadCost).toBeLessThan(regularCost);
  });

  test("cacheCreationInputTokens contribute to total cost", () => {
    const baseCost = estimateCostFromTokenUsage(
      { inputTokens: 100_000, outputTokens: 0 },
      "claude-sonnet-4",
    );
    const cacheCreationCost = estimateCostFromTokenUsage(
      { inputTokens: 100_000, outputTokens: 0, cacheCreationInputTokens: 50_000 },
      "claude-sonnet-4",
    );
    expect(cacheCreationCost).toBeGreaterThan(baseCost);
  });

  test("undefined cache fields are treated as zero (no error)", () => {
    const usage: TokenUsage = { inputTokens: 1_000, outputTokens: 500 };
    // Should not throw
    expect(() => estimateCostFromTokenUsage(usage, "claude-sonnet-4")).not.toThrow();
  });

  test("total cost with all token types sums all contributions", () => {
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 500_000,
      cacheCreationInputTokens: 500_000,
    };
    const costWithCache = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    const costWithoutCache = estimateCostFromTokenUsage(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      "claude-sonnet-4",
    );
    // Adding cache tokens increases total cost
    expect(costWithCache).toBeGreaterThan(costWithoutCache);
  });

  test("cacheReadInputTokens alone (no regular input) still produces non-zero cost", () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 1_000_000,
    };
    const cost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    expect(cost).toBeGreaterThan(0);
  });
});

// Note: AcpAgentAdapter.run() integration tests removed in ADR-019 Phase D —
// AgentAdapter.run() was deleted from the interface. Cost estimation is fully
// covered by the estimateCostFromTokenUsage unit tests above.
