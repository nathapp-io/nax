/**
 * NaxConfigSchema — complexityRouting rung-qualified entries (spec §6)
 *
 * A complexityRouting entry may be a bare tier (default-agent semantics,
 * unchanged) or an object { tier, agent } naming a cross-agent rung so
 * unprofiled stories can start on a non-default agent's cheap rungs.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { NaxConfigSchema } from "@/config/schemas";

describe("complexityRouting — rung-qualified entries (spec §6)", () => {
  const MODELS = {
    claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" },
    native: { cheap: "opencode-go/deepseek-v4-flash" },
  };

  function withComplexityRouting(complexityRouting: unknown, models: unknown = MODELS) {
    return NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      models,
      // An entry under models.native demands a native-capable agent.protocol (PerAgentModelMapSchema gate).
      agent: { ...DEFAULT_CONFIG.agent, protocol: "hybrid" },
      autoMode: { ...DEFAULT_CONFIG.autoMode, complexityRouting },
    });
  }

  test("accepts rung objects and bare tiers", () => {
    expect(
      withComplexityRouting({
        simple: { tier: "cheap", agent: "native" },
        medium: { tier: "balanced", agent: "native" },
        complex: { tier: "balanced", agent: "claude" },
        expert: "powerful",
      }).success,
    ).toBe(true);
  });

  test("rejects an empty agent on a rung", () => {
    expect(
      withComplexityRouting({
        ...DEFAULT_CONFIG.autoMode.complexityRouting,
        simple: { tier: "cheap", agent: "" },
      }).success,
    ).toBe(false);
  });
});
