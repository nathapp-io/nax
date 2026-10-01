/**
 * Schema types tests for ModelsConfig, TierConfig, and StoryRouting
 *
 * Tests the new type structures:
 * - TierConfig: optional agent field
 * - StoryRouting: optional agent field
 *
 * These tests use type-level assertions to ensure the agent field is properly
 * defined in the interfaces. TypeScript compilation will fail if the field is missing.
 */

import { describe, expect, test } from "bun:test";
import { assertNaxError } from "@test/helpers";
import type { ModelsConfig, TierConfig } from "@/config/schema-types";
import {
  isUnrecognizedLiteralModel,
  resolveConfiguredModel,
  resolveModelForAgent,
  resolveTierMembership,
} from "@/config/schema-types";
import { NaxError } from "@/errors";
import { addSink, initLogger, resetLogger } from "@/logger";
import type { StoryRouting } from "@/prd/types";

// Type-level assertions to ensure agent field exists
// These will cause compilation errors if the field is missing from the interfaces
type AssertTierConfigHasAgent = TierConfig extends { agent?: string } ? true : false;
type AssertStoryRoutingHasAgent = StoryRouting extends { agent?: string } ? true : false;

const _tierConfigAgentCheck: AssertTierConfigHasAgent = true;
const _storyRoutingAgentCheck: AssertStoryRoutingHasAgent = true;

describe("TierConfig type structure", () => {
  test("TierConfig should accept optional agent field", () => {
    const tierConfig: TierConfig = {
      tier: "fast",
      attempts: 3,
      agent: "claude",
    };

    expect(tierConfig.tier).toBe("fast");
    expect(tierConfig.attempts).toBe(3);
    expect(tierConfig.agent).toBe("claude");
  });

  test("TierConfig should remain valid without agent field (backward compatibility)", () => {
    const tierConfig: TierConfig = {
      tier: "balanced",
      attempts: 5,
    };

    expect(tierConfig.tier).toBe("balanced");
    expect(tierConfig.attempts).toBe(5);
  });

  test("TierConfig with agent field should support various agent names", () => {
    const examples: TierConfig[] = [
      { tier: "fast", attempts: 2, agent: "claude" },
      { tier: "balanced", attempts: 3, agent: "codex" },
      { tier: "powerful", attempts: 4, agent: "gemini" },
      { tier: "powerful", attempts: 1, agent: "opencode" },
    ];

    for (const config of examples) {
      expect(config.agent).toBeDefined();
      expect(typeof config.agent).toBe("string");
    }
  });
});

describe("StoryRouting type structure", () => {
  test("StoryRouting should accept optional agent field", () => {
    const routing: StoryRouting = {
      complexity: "medium",
      testStrategy: "tdd-simple",
      reasoning: "Standard feature implementation",
      agent: "claude",
    };

    expect(routing.complexity).toBe("medium");
    expect(routing.testStrategy).toBe("tdd-simple");
    expect(routing.agent).toBe("claude");
  });

  test("StoryRouting should remain valid without agent field (backward compatibility)", () => {
    const routing: StoryRouting = {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "Simple bug fix",
    };

    expect(routing.complexity).toBe("simple");
    expect(routing.testStrategy).toBe("test-after");
  });

  test("StoryRouting with agent field should support various agent names", () => {
    const examples: StoryRouting[] = [
      { complexity: "simple", testStrategy: "no-test", reasoning: "Doc update", agent: "claude" },
      { complexity: "medium", testStrategy: "tdd-simple", reasoning: "Feature", agent: "codex" },
      { complexity: "complex", testStrategy: "three-session-tdd", reasoning: "Complex", agent: "gemini" },
    ];

    for (const routing of examples) {
      expect(routing.agent).toBeDefined();
      expect(typeof routing.agent).toBe("string");
    }
  });

  test("StoryRouting maintains all existing fields with optional agent", () => {
    const routing: StoryRouting = {
      complexity: "complex",
      initialComplexity: "simple",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "Multi-tiered approach needed",
      estimatedCostUsd: 5.5,
      estimatedLOC: 250,
      risks: ["database migration", "backward compatibility"],
      strategy: "llm",
      llmModel: "claude-3.5-sonnet",
      agent: "claude",
    };

    expect(routing.agent).toBe("claude");
    expect(routing.complexity).toBe("complex");
    expect(routing.modelTier).toBe("powerful");
    expect(routing.risks?.length).toBe(2);
  });
});

describe("resolveModelForAgent", () => {
  const models: ModelsConfig = {
    claude: {
      fast: "claude-haiku-4-5",
      balanced: "claude-sonnet-4-5",
      powerful: "claude-opus-4-5",
    },
    codex: {
      fast: { provider: "openai", model: "codex-mini" },
    },
  };

  test("returns agent's own tier entry when it exists (string model)", () => {
    const result = resolveModelForAgent(models, "claude", "fast", "claude");
    expect(result).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("returns agent's own tier entry when it exists (object model)", () => {
    const result = resolveModelForAgent(models, "codex", "fast", "claude");
    expect(result).toEqual({ provider: "openai", model: "codex-mini" });
  });

  test("falls back to defaultAgent tier when requested agent has no entry for that tier", () => {
    const result = resolveModelForAgent(models, "codex", "powerful", "claude");
    expect(result).toEqual({ provider: "anthropic", model: "claude-opus-4-5" });
  });

  test("falls back to defaultAgent tier when requested agent key is missing entirely", () => {
    const result = resolveModelForAgent(models, "unknown-agent", "fast", "claude");
    expect(result).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("throws NaxError with code MODEL_NOT_FOUND when neither agent nor defaultAgent has the tier", () => {
    expect(() => resolveModelForAgent(models, "unknown-agent", "balanced", "codex")).toThrow(NaxError);
  });

  test("thrown NaxError has code MODEL_NOT_FOUND", () => {
    let thrown: unknown;
    try {
      resolveModelForAgent(models, "unknown-agent", "balanced", "codex");
    } catch (err) {
      thrown = err;
    }
    assertNaxError(thrown);
    expect(thrown.code).toBe("MODEL_NOT_FOUND");
  });

  test("throws NaxError when defaultAgent itself is missing", () => {
    expect(() => resolveModelForAgent(models, "unknown-agent", "fast", "no-such-default")).toThrow(NaxError);
  });
});

describe("resolveConfiguredModel", () => {
  const models: ModelsConfig = {
    claude: {
      fast: "claude-haiku-4-5",
      balanced: "claude-sonnet-4-5",
      powerful: "claude-opus-4-5",
    },
    codex: {
      fast: { provider: "openai", model: "gpt-5.4-mini" },
      balanced: { provider: "openai", model: "gpt-5.4" },
    },
  };

  test("resolves string selectors via resolveModelForAgent using the preferred agent", () => {
    const result = resolveConfiguredModel(models, "claude", "balanced", "claude");

    expect(result.agent).toBe("claude");
    expect(result.modelTier).toBe("balanced");
    expect(result.modelDef).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  test("resolves object selectors with tier labels through the object agent", () => {
    const result = resolveConfiguredModel(models, "claude", { agent: "codex", model: "fast" }, "claude");

    expect(result.agent).toBe("codex");
    expect(result.modelTier).toBe("fast");
    expect(result.modelDef).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
  });

  test("resolves shorthand aliases to builtin tiers", () => {
    const result = resolveConfiguredModel(models, "claude", { agent: "claude", model: "sonnet" }, "claude");

    expect(result.agent).toBe("claude");
    expect(result.modelTier).toBe("balanced");
    expect(result.modelDef).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });

  test("passes through raw model ids from object selectors", () => {
    const result = resolveConfiguredModel(models, "claude", { agent: "codex", model: "gpt-5.4" }, "claude");

    expect(result.agent).toBe("codex");
    expect(result.modelTier).toBeUndefined();
    expect(result.modelDef).toEqual({ provider: "openai", model: "gpt-5.4" });
  });
});

describe("resolveTierMembership (spec §3)", () => {
  const models = {
    claude: { fast: "claude-haiku-4-5", balanced: "claude-sonnet-5", powerful: "claude-opus-5" },
    native: { cheap: "opencode-go/deepseek-v4-flash", turbo: { provider: "opencode-go", model: "deepseek-v4-turbo" } },
  };

  test("own-map custom tier is a tier", () => {
    expect(resolveTierMembership(models, "native", "cheap", "claude")).toEqual({
      isTier: true,
      viaDefaultAgentFallback: false,
    });
  });

  test("defaultAgent-fallback tier is a tier, flagged", () => {
    expect(resolveTierMembership(models, "native", "balanced", "claude")).toEqual({
      isTier: true,
      viaDefaultAgentFallback: true,
    });
  });

  test("unknown name is not a tier", () => {
    expect(resolveTierMembership(models, "native", "gpt-5", "claude").isTier).toBe(false);
  });

  test("custom tier resolves through the object form with modelTier set", () => {
    const r = resolveConfiguredModel(models, "claude", { agent: "native", model: "turbo" }, "claude");
    expect(r).toEqual({
      agent: "native",
      modelDef: { provider: "opencode-go", model: "deepseek-v4-turbo" },
      modelTier: "turbo",
    });
  });

  test("object and string spellings agree on a custom tier", () => {
    const obj = resolveConfiguredModel(models, "native", { agent: "native", model: "cheap" }, "claude");
    const str = resolveConfiguredModel(models, "native", "cheap", "claude");
    expect(obj).toEqual(str);
  });

  test("fallback-tier membership keeps the target agent", () => {
    const r = resolveConfiguredModel(models, "claude", { agent: "native", model: "balanced" }, "claude");
    expect(r.agent).toBe("native");
    expect(r.modelTier).toBe("balanced");
    expect(r.modelDef.model).toBe("claude-sonnet-5");
  });

  test("fallback-tier membership warns across a native/ACP boundary", () => {
    const messages: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => messages.push(entry.message));
    try {
      resolveConfiguredModel(models, "claude", { agent: "native", model: "balanced" }, "claude");
      expect(messages).toContain("Configured tier resolves via the default agent across a protocol boundary");
    } finally {
      removeSink();
      resetLogger();
    }
  });

  test("provider-qualified literal stays a pin (modelTier absent)", () => {
    const r = resolveConfiguredModel(models, "claude", { agent: "native", model: "opencode-go/qwen-4" }, "claude");
    expect(r.modelTier).toBeUndefined();
    expect(r.modelDef.model).toBe("opencode-go/qwen-4");
  });

  test("known-prefix literal stays a pin", () => {
    const r = resolveConfiguredModel(models, "claude", { agent: "claude", model: "claude-opus-5-1" }, "claude");
    expect(r.modelTier).toBeUndefined();
    expect(r.modelDef.provider).toBe("anthropic");
  });

  test("isUnrecognizedLiteralModel", () => {
    expect(isUnrecognizedLiteralModel("turbo")).toBe(true);
    expect(isUnrecognizedLiteralModel("opencode-go/qwen-4")).toBe(false);
    expect(isUnrecognizedLiteralModel("claude-opus-5")).toBe(false);
    expect(isUnrecognizedLiteralModel("gpt-5")).toBe(false);
  });
});
