/**
 * Unit tests for src/agents/shared/validation.ts — tier and feature
 * capability checks, and the human-readable capability summary.
 */

import { describe, expect, test } from "bun:test";
import { makeAgentAdapter } from "@test/helpers";
import { describeAgentCapabilities, validateAgentFeature, validateAgentForTier } from "@/agents/shared/validation";

describe("validateAgentForTier", () => {
  test("returns true when the tier is in supportedTiers", () => {
    const agent = makeAgentAdapter({
      capabilities: { supportedTiers: ["fast", "balanced"], maxContextTokens: 100_000, features: new Set() },
    });
    expect(validateAgentForTier(agent, "fast")).toBe(true);
    expect(validateAgentForTier(agent, "balanced")).toBe(true);
  });

  test("returns false when the tier is not in supportedTiers", () => {
    const agent = makeAgentAdapter({
      capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set() },
    });
    expect(validateAgentForTier(agent, "powerful")).toBe(false);
  });
});

describe("validateAgentFeature", () => {
  test("returns true when the feature is declared", () => {
    const agent = makeAgentAdapter({
      capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set(["tdd", "review"]) },
    });
    expect(validateAgentFeature(agent, "tdd")).toBe(true);
    expect(validateAgentFeature(agent, "review")).toBe(true);
  });

  test("returns false when the feature is absent", () => {
    const agent = makeAgentAdapter({
      capabilities: { supportedTiers: ["fast"], maxContextTokens: 100_000, features: new Set(["tdd"]) },
    });
    expect(validateAgentFeature(agent, "refactor")).toBe(false);
    expect(validateAgentFeature(agent, "batch")).toBe(false);
  });
});

describe("describeAgentCapabilities", () => {
  test("formats name, tiers, maxTokens and features into one summary line", () => {
    const agent = makeAgentAdapter({
      name: "claude",
      capabilities: {
        supportedTiers: ["fast", "balanced", "powerful"],
        maxContextTokens: 200_000,
        features: new Set(["tdd", "review", "refactor", "batch"]),
      },
    });
    const summary = describeAgentCapabilities(agent);
    expect(summary).toBe(
      "claude: tiers=[fast,balanced,powerful], maxTokens=200000, features=[tdd,review,refactor,batch]",
    );
  });

  test("renders an empty features set as an empty bracket", () => {
    const agent = makeAgentAdapter({
      name: "bare",
      capabilities: { supportedTiers: ["fast"], maxContextTokens: 8000, features: new Set() },
    });
    expect(describeAgentCapabilities(agent)).toBe("bare: tiers=[fast], maxTokens=8000, features=[]");
  });
});
