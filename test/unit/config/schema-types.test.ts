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
import type { TierConfig } from "../../../src/config/schema-types";
import type { StoryRouting } from "../../../src/prd/types";

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
      estimatedCost: 5.5,
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
