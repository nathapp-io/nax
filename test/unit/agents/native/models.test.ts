/**
 * Model reference parsing, usage mapping and cost for the native path.
 *
 * The provider travels in the model string because a multi-provider agent needs
 * it there — opencode already does this (ADR-027 section 1).
 */

import { describe, expect, test } from "bun:test";
import { estimateCostUsd, parseNativeModel, toNaxTokenUsage } from "@/agents/native/models";

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

  test("counts cache tokens as input when present", () => {
    const cost = estimateCostUsd(
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 },
      { inputPer1M: 3, outputPer1M: 15 },
    );
    expect(cost).toBeGreaterThan(0);
  });
});
