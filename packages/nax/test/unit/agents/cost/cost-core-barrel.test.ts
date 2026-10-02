import { describe, expect, test } from "bun:test";
import { coreModule as costCore } from "@nathapp/nax-agent/internal";
import * as costBarrel from "@/agents/cost";

describe("@/agents/cost/core", () => {
  test("serves the same function objects as @/agents/cost", () => {
    expect(costCore.priceCall).toBe(costBarrel.priceCall);
    expect(costCore.estimateCostUsd).toBe(costBarrel.estimateCostUsd);
    expect(costCore.inputClassTokens).toBe(costBarrel.inputClassTokens);
    expect(costCore.addTokenUsage).toBe(costBarrel.addTokenUsage);
  });

  test("inputClassTokens counts input plus both cache classes, not output", () => {
    expect(
      costCore.inputClassTokens({ inputTokens: 10, outputTokens: 99, cacheReadTokens: 5, cacheWriteTokens: 2 }),
    ).toBe(17);
  });
});
