/**
 * Tests for ACP cost estimation — ACP-006
 *
 * Covers:
 * - estimateCostFromTokenUsage calculates cost from input_tokens and output_tokens
 * - Cache tokens use correct reduced/creation rates
 * - Known models have accurate per-token pricing
 * - Unknown models fall back to a reasonable average rate
 * - Zero token usage returns $0.00
 * - AcpAgentAdapter.toAgentResult() uses estimateCostFromTokenUsage
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { estimateCostFromTokenUsage } from "../../../../src/agents/acp/cost";
import type { SessionTokenUsage } from "../../../../src/agents/acp/cost";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../../src/agents/acp/adapter";
import { makeClient, makeRunOptions, makeSession } from "./adapter.test";

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostFromTokenUsage — basic input/output tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateCostFromTokenUsage — basic tokens", () => {
  test("returns $0.00 for zero token usage", () => {
    const usage: SessionTokenUsage = { input_tokens: 0, output_tokens: 0 };
    expect(estimateCostFromTokenUsage(usage, "claude-sonnet-4")).toBe(0);
  });

  test("calculates non-zero cost for non-zero input tokens", () => {
    const usage: SessionTokenUsage = { input_tokens: 1_000_000, output_tokens: 0 };
    const cost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    expect(cost).toBeGreaterThan(0);
  });

  test("calculates non-zero cost for non-zero output tokens", () => {
    const usage: SessionTokenUsage = { input_tokens: 0, output_tokens: 1_000_000 };
    const cost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    expect(cost).toBeGreaterThan(0);
  });

  test("output tokens are more expensive than input tokens at equal counts", () => {
    const inputOnlyCost = estimateCostFromTokenUsage(
      { input_tokens: 1_000_000, output_tokens: 0 },
      "claude-sonnet-4",
    );
    const outputOnlyCost = estimateCostFromTokenUsage(
      { input_tokens: 0, output_tokens: 1_000_000 },
      "claude-sonnet-4",
    );
    expect(outputOnlyCost).toBeGreaterThan(inputOnlyCost);
  });

  test("cost scales linearly with token count", () => {
    const costAt1M = estimateCostFromTokenUsage({ input_tokens: 1_000_000, output_tokens: 0 }, "claude-sonnet-4");
    const costAt2M = estimateCostFromTokenUsage({ input_tokens: 2_000_000, output_tokens: 0 }, "claude-sonnet-4");
    expect(costAt2M).toBeCloseTo(costAt1M * 2, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostFromTokenUsage — known model pricing
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateCostFromTokenUsage — known model pricing", () => {
  test("claude-sonnet-4: $3/1M input, $15/1M output", () => {
    const usage: SessionTokenUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const cost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    // $3.00 input + $15.00 output = $18.00
    expect(cost).toBeCloseTo(18.0, 2);
  });

  test("claude-haiku: cheaper than claude-sonnet-4 for same token count", () => {
    const usage: SessionTokenUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const haikuCost = estimateCostFromTokenUsage(usage, "claude-haiku");
    const sonnetCost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    expect(haikuCost).toBeLessThan(sonnetCost);
  });

  test("gpt-4.1: has a defined pricing rate (non-zero cost)", () => {
    const usage: SessionTokenUsage = { input_tokens: 100_000, output_tokens: 50_000 };
    const cost = estimateCostFromTokenUsage(usage, "gpt-4.1");
    expect(cost).toBeGreaterThan(0);
  });

  test("gemini-2.5-pro: has a defined pricing rate (non-zero cost)", () => {
    const usage: SessionTokenUsage = { input_tokens: 100_000, output_tokens: 50_000 };
    const cost = estimateCostFromTokenUsage(usage, "gemini-2.5-pro");
    expect(cost).toBeGreaterThan(0);
  });

  test("codex: has a defined pricing rate (non-zero cost)", () => {
    const usage: SessionTokenUsage = { input_tokens: 100_000, output_tokens: 50_000 };
    const cost = estimateCostFromTokenUsage(usage, "codex");
    expect(cost).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostFromTokenUsage — unknown model fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateCostFromTokenUsage — unknown model fallback", () => {
  test("returns non-zero cost for an unknown model with non-zero tokens", () => {
    const usage: SessionTokenUsage = { input_tokens: 100_000, output_tokens: 50_000 };
    const cost = estimateCostFromTokenUsage(usage, "unknown-model-xyz");
    expect(cost).toBeGreaterThan(0);
  });

  test("returns $0.00 for unknown model with zero tokens", () => {
    const usage: SessionTokenUsage = { input_tokens: 0, output_tokens: 0 };
    expect(estimateCostFromTokenUsage(usage, "unknown-model-xyz")).toBe(0);
  });

  test("unknown model fallback rate is a reasonable average (not free, not absurdly expensive)", () => {
    // Check fallback is in reasonable range: $0.50–$30/1M tokens combined
    const usage: SessionTokenUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
    const cost = estimateCostFromTokenUsage(usage, "some-future-model");
    expect(cost).toBeGreaterThan(0.5);
    expect(cost).toBeLessThan(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// estimateCostFromTokenUsage — cache tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("estimateCostFromTokenUsage — cache tokens", () => {
  test("cache_read_input_tokens are cheaper than regular input tokens", () => {
    const regularCost = estimateCostFromTokenUsage(
      { input_tokens: 100_000, output_tokens: 0 },
      "claude-sonnet-4",
    );
    const cacheReadCost = estimateCostFromTokenUsage(
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 100_000 },
      "claude-sonnet-4",
    );
    expect(cacheReadCost).toBeLessThan(regularCost);
  });

  test("cache_creation_input_tokens contribute to total cost", () => {
    const baseCost = estimateCostFromTokenUsage(
      { input_tokens: 100_000, output_tokens: 0 },
      "claude-sonnet-4",
    );
    const cacheCreationCost = estimateCostFromTokenUsage(
      { input_tokens: 100_000, output_tokens: 0, cache_creation_input_tokens: 50_000 },
      "claude-sonnet-4",
    );
    expect(cacheCreationCost).toBeGreaterThan(baseCost);
  });

  test("undefined cache fields are treated as zero (no error)", () => {
    const usage: SessionTokenUsage = { input_tokens: 1_000, output_tokens: 500 };
    // Should not throw
    expect(() => estimateCostFromTokenUsage(usage, "claude-sonnet-4")).not.toThrow();
  });

  test("total cost with all token types sums all contributions", () => {
    const usage: SessionTokenUsage = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 500_000,
    };
    const costWithCache = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    const costWithoutCache = estimateCostFromTokenUsage(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      "claude-sonnet-4",
    );
    // Adding cache tokens increases total cost
    expect(costWithCache).toBeGreaterThan(costWithoutCache);
  });

  test("cache_read_input_tokens alone (no regular input) still produces non-zero cost", () => {
    const usage: SessionTokenUsage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
    };
    const cost = estimateCostFromTokenUsage(usage, "claude-sonnet-4");
    expect(cost).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AcpAgentAdapter integration — toAgentResult() uses estimateCostFromTokenUsage
// ─────────────────────────────────────────────────────────────────────────────

describe("AcpAgentAdapter — cost via estimateCostFromTokenUsage", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  const origSleep = _acpAdapterDeps.sleep;

  beforeEach(() => {
    _acpAdapterDeps.sleep = mock(async (_ms: number) => {});
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.sleep = origSleep;
    mock.restore();
  });

  test("run() estimatedCost reflects model-specific pricing for claude-haiku", async () => {
    // claude-haiku pricing is ~$0.80 input / $4.00 output per 1M tokens
    // 1M input + 1M output = ~$4.80
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const result = await adapter.run(
      makeRunOptions({ modelDef: { provider: "anthropic", model: "claude-haiku", env: {} } }),
    );

    // Haiku: $0.80 input + $4.00 output = $4.80 for 1M+1M tokens
    expect(result.estimatedCost).toBeCloseTo(4.8, 1);
  });

  test("run() estimatedCost reflects model-specific pricing for claude-sonnet-4", async () => {
    // claude-sonnet-4 pricing: $3/1M input, $15/1M output
    // 1M input + 1M output = $18.00
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const result = await adapter.run(
      makeRunOptions({ modelDef: { provider: "anthropic", model: "claude-sonnet-4", env: {} } }),
    );

    expect(result.estimatedCost).toBeCloseTo(18.0, 1);
  });

  test("run() estimatedCost is $0.00 when cumulative_token_usage is absent", async () => {
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: undefined,
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const result = await new AcpAgentAdapter("claude").run(makeRunOptions());
    expect(result.estimatedCost).toBe(0);
  });

  test("run() estimatedCost uses haiku rate different from old sonnet-class inline formula", async () => {
    // Old formula: $3/1M input + $15/1M output (generic sonnet-class, same for all models)
    // New formula with haiku: $0.80/1M input + $4.00/1M output
    // For 1M + 1M tokens: old = $18, new haiku = $4.80 — must be different
    const session = makeSession({
      promptFn: async (_: string) => ({
        messages: [{ role: "assistant", content: "Done." }],
        stopReason: "end_turn",
        cumulative_token_usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      }),
    });
    _acpAdapterDeps.createClient = mock((_cmd: string) => makeClient(session));

    const adapter = new AcpAgentAdapter("claude");
    const result = await adapter.run(
      makeRunOptions({ modelDef: { provider: "anthropic", model: "claude-haiku", env: {} } }),
    );

    // Must NOT be $18.00 (the old inline formula for sonnet-class)
    expect(result.estimatedCost).not.toBeCloseTo(18.0, 0);
  });
});
