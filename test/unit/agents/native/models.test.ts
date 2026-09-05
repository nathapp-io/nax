/**
 * Model reference parsing, usage mapping and cost for the native path.
 *
 * The provider travels in the model string because a multi-provider agent needs
 * it there — opencode already does this (ADR-027 section 1).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  buildRateCard,
  estimateCostUsd,
  parseNativeModel,
  resolveContextWindow,
  toNaxTokenUsage,
  toThinkingLevel,
} from "@/agents/native/models";
import type { TokenPricing } from "@/config/schema-types";
import { NaxError } from "@/errors";
import { getLogger, initLogger, resetLogger } from "@/logger";

describe("parseNativeModel", () => {
  test("splits provider from model", () => {
    expect(parseNativeModel("opencode-go/deepseek-v4-flash")).toEqual({
      provider: "opencode-go",
      model: "deepseek-v4-flash",
    });
  });

  test("splits on the first slash so multi-segment model ids survive", () => {
    expect(parseNativeModel("huggingface/MiniMaxAI/MiniMax-M2.7")).toEqual({
      provider: "huggingface",
      model: "MiniMaxAI/MiniMax-M2.7",
    });
  });

  test("rejects a string with no provider, naming the remedy", () => {
    expect(() => parseNativeModel("claude-sonnet-5")).toThrow(/provider\/model/);
  });

  test("rejects an empty provider or model half", () => {
    expect(() => parseNativeModel("/deepseek-v4-flash")).toThrow();
    expect(() => parseNativeModel("openai/")).toThrow();
  });

  // The suffix is trailing, so it must be stripped BEFORE the slash split —
  // otherwise "anthropic/claude-opus-5[high]" would hand "claude-opus-5[high]"
  // straight to client.model(), which throws its own unknown-model error.
  test("strips a trailing effort suffix before splitting on the slash", () => {
    expect(parseNativeModel("anthropic/claude-opus-5[high]")).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      effort: "high",
    });
  });

  test("omits effort entirely when the model string carries no suffix", () => {
    const parsed = parseNativeModel("anthropic/claude-opus-5");
    expect(parsed).toEqual({ provider: "anthropic", model: "claude-opus-5" });
    expect("effort" in parsed).toBe(false);
  });

  // A suffix with no slash must still fail malformed-model validation, not
  // silently succeed by treating the whole bracketed string as a model id
  // handed to an unadvertised provider.
  test("still rejects a suffix with no provider", () => {
    expect(() => parseNativeModel("claude-opus-5[high]")).toThrow(/provider\/model/);
  });
});

describe("toThinkingLevel", () => {
  beforeEach(() => {
    resetLogger();
    initLogger({ level: "silent" });
  });

  afterEach(() => {
    resetLogger();
  });

  test("returns undefined when no effort was supplied", () => {
    expect(toThinkingLevel(undefined)).toBeUndefined();
  });

  test("passes through every level nax-ai recognizes", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
    for (const level of levels) {
      expect(toThinkingLevel(level)).toBe(level);
    }
  });

  test("warns and returns undefined for an unrecognized effort, rather than throwing", () => {
    const logger = getLogger();
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

    expect(toThinkingLevel("ultra-mega")).toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toContain("ultra-mega");
  });
});

describe("toNaxTokenUsage", () => {
  test("renames the cache fields to nax's names", () => {
    expect(toNaxTokenUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 2,
    });
  });

  test("leaves absent cache fields absent rather than zero", () => {
    const mapped = toNaxTokenUsage({ inputTokens: 10, outputTokens: 5 });
    expect(mapped).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect("cacheReadInputTokens" in mapped).toBe(false);
  });
});

describe("estimateCostUsd", () => {
  test("bills input and output at rates per 1M tokens", () => {
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 500_000 }, { inputPer1M: 3, outputPer1M: 15 });
    expect(cost).toBeCloseTo(3 + 7.5, 6);
  });

  test("falls back to the input rate for cache tokens when no cache rate is configured", () => {
    const cost = estimateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 },
      { inputPer1M: 3, outputPer1M: 15 },
    );
    // Both cache classes fall back to inputPer1M (3): 1M read + 1M write = $6.
    expect(cost).toBeCloseTo(6, 6);
  });

  test("bills cache reads at cacheReadPer1M when the rate card supplies one", () => {
    const cost = estimateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 },
      { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3 },
    );
    // The over-report this fixes: at the old behaviour this would have been $3.
    expect(cost).toBeCloseTo(0.3, 6);
  });

  test("bills cache writes at cacheCreationPer1M when the rate card supplies one", () => {
    const cost = estimateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000 },
      { inputPer1M: 3, outputPer1M: 15, cacheCreationPer1M: 3.75 },
    );
    // The under-report this fixes: at the old behaviour this would have been $3
    // even though a cache write costs MORE than plain input, not the same.
    expect(cost).toBeCloseTo(3.75, 6);
  });

  test("prices reads and writes independently in the same call", () => {
    const cost = estimateCostUsd(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      },
      { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheCreationPer1M: 3.75 },
    );
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75, 6);
  });
});

// nax#1847: 22 of 1290 catalogued models price in tiers (Pricing.tiers). The
// worked example from docs/architecture/nax-ai-surface.md,
// openai/gpt-5.6-terra: base {input:2, output:12, cacheRead:0.2,
// cacheWrite:2.5}, tier above 272000 total input-class tokens {input:4,
// output:18, cacheRead:0.4, cacheWrite:5}.
describe("estimateCostUsd with pricing tiers", () => {
  const TIERED_RATES: TokenPricing = {
    inputPer1M: 2,
    outputPer1M: 12,
    cacheReadPer1M: 0.2,
    cacheCreationPer1M: 2.5,
    tiers: [{ inputPer1M: 4, outputPer1M: 18, cacheReadPer1M: 0.4, cacheCreationPer1M: 5, inputTokensAbove: 272_000 }],
  };

  test("below the threshold bills at base rates", () => {
    const cost = estimateCostUsd({ inputTokens: 100_000, outputTokens: 1_000_000 }, TIERED_RATES);
    expect(cost).toBeCloseTo((100_000 / 1_000_000) * 2 + (1_000_000 / 1_000_000) * 12, 6);
  });

  // "the highest matching threshold applies to the whole request" -- output
  // and both cache classes reprice too, not just the input tokens that
  // pushed the request over the threshold.
  test("above the threshold reprices the WHOLE request at tier rates, including output and cache classes", () => {
    const usage = {
      inputTokens: 300_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 100_000,
      cacheCreationInputTokens: 50_000,
    };
    // total input-class usage = 300_000 + 100_000 + 50_000 = 450_000, which
    // exceeds the 272_000 threshold.
    const cost = estimateCostUsd(usage, TIERED_RATES);
    const expected =
      (300_000 / 1_000_000) * 4 + (1_000_000 / 1_000_000) * 18 + (100_000 / 1_000_000) * 0.4 + (50_000 / 1_000_000) * 5;
    expect(cost).toBeCloseTo(expected, 6);
  });

  // Tiers count toward the threshold from cache tokens too, not just fresh
  // input -- otherwise a heavily-cached long-context request would never
  // cross it.
  test("cache-read and cache-creation tokens count toward the threshold, not just fresh input", () => {
    const usage = { inputTokens: 100_000, outputTokens: 0, cacheReadInputTokens: 172_001 };
    // 100_000 + 172_001 = 272_001, one token over.
    const cost = estimateCostUsd(usage, TIERED_RATES);
    const expected = (100_000 / 1_000_000) * 4 + (172_001 / 1_000_000) * 0.4;
    expect(cost).toBeCloseTo(expected, 6);
  });

  // nax-ai's own doc comment: "Applies when total input usage EXCEEDS this
  // token count." Exceeds is strict, so a request landing exactly on the
  // threshold does not cross it -- base rates win. Pinned here because the
  // alternative (>=) would also look plausible to a future reader.
  test("exactly AT the threshold does not exceed it, so base rates win", () => {
    const cost = estimateCostUsd({ inputTokens: 272_000, outputTokens: 0 }, TIERED_RATES);
    expect(cost).toBeCloseTo((272_000 / 1_000_000) * 2, 6);
  });

  test("one token above the threshold applies the tier", () => {
    const cost = estimateCostUsd({ inputTokens: 272_001, outputTokens: 0 }, TIERED_RATES);
    expect(cost).toBeCloseTo((272_001 / 1_000_000) * 4, 6);
  });

  test("a rate card with no tiers is unaffected", () => {
    const cost = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 0 }, { inputPer1M: 3, outputPer1M: 15 });
    expect(cost).toBeCloseTo(3, 6);
  });
});

// US-003: buildRateCard returns both the rate object AND the source discriminant
// (config-override when an override was supplied, catalog-rates otherwise). The
// adapter stamps the source on CompleteResult.pricingSource and TurnResult.pricingSource.
describe("buildRateCard", () => {
  test("US-003 AC1: catalog with no override returns catalog-rates source and the catalog's cache rates", () => {
    const catalog = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const { rates, source } = buildRateCard(catalog, undefined);
    expect(source).toBe("catalog-rates");
    expect(rates).toEqual({
      inputPer1M: 2,
      outputPer1M: 10,
      cacheReadPer1M: 0.2,
      cacheCreationPer1M: 2.5,
    });
  });

  test("US-003 AC2: explicit override returns config-override source and the override object wholesale", () => {
    const catalog = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const override: TokenPricing = { inputPer1M: 99, outputPer1M: 199 };
    const { rates, source } = buildRateCard(catalog, override);
    expect(source).toBe("config-override");
    expect(rates).toBe(override);
    expect(rates.cacheReadPer1M).toBeUndefined();
  });

  test("US-003 AC3: catalog with tiers returns catalog-rates source and tiers translated to nax's field names", () => {
    const catalog = {
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      tiers: [{ inputTokensAbove: 272_000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 }],
    };
    const { rates, source } = buildRateCard(catalog, undefined);
    expect(source).toBe("catalog-rates");
    expect(rates.tiers).toEqual([
      { inputPer1M: 4, outputPer1M: 18, cacheReadPer1M: 0.4, cacheCreationPer1M: 5, inputTokensAbove: 272_000 },
    ]);
  });
});

/**
 * nax#1848: ModelDef.contextWindow overrides nax-ai's ResolvedModel.contextWindow.
 * Mirrors buildRateCard's override-then-fallback pattern, but with a direction
 * guard buildRateCard has no equivalent of: only lowering the window is safe
 * (it never reaches the provider, feeding only shouldCompact/keepBudget), so an
 * override above the real window is rejected rather than clamped.
 */
describe("resolveContextWindow", () => {
  test("an override below the real window wins", () => {
    expect(resolveContextWindow(20_000, 128_000)).toBe(20_000);
  });

  test("no override falls back to the real window", () => {
    expect(resolveContextWindow(undefined, 128_000)).toBe(128_000);
  });

  test("an override above the real window is rejected, naming both numbers", () => {
    expect(() => resolveContextWindow(200_000, 128_000)).toThrow(NaxError);
    try {
      resolveContextWindow(200_000, 128_000);
      throw new Error("expected resolveContextWindow to throw");
    } catch (err) {
      if (!(err instanceof NaxError)) throw err;
      expect(err.message).toContain("200000");
      expect(err.message).toContain("128000");
    }
  });

  test("an override exactly equal to the real window is accepted, not rejected", () => {
    expect(resolveContextWindow(128_000, 128_000)).toBe(128_000);
  });
});
