/**
 * Model reference parsing, usage mapping and cost for the native path.
 *
 * The provider travels in the model string because a multi-provider agent needs
 * it there — opencode already does this (ADR-027 section 1).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { estimateCostUsd, parseNativeModel, toNaxTokenUsage, toThinkingLevel } from "@/agents/native/models";
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
