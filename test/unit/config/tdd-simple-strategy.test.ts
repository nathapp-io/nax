/**
 * TS-001: tdd-simple TestStrategy type and router validation
 *
 * Failing tests (RED phase):
 * - TestStrategy type includes 'tdd-simple'
 * - determineTestStrategy returns tdd-simple for simple complexity in auto mode
 * - test-after is only returned when tddStrategy is 'off'
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { initLogger, resetLogger } from "../../../src/logger";

beforeEach(() => {
  resetLogger();
  initLogger({ level: "error", useChalk: false });
});

afterEach(() => {
  mock.restore();
  resetLogger();
});

// ---------------------------------------------------------------------------
// TS-001: determineTestStrategy returns tdd-simple for simple in auto mode
// ---------------------------------------------------------------------------

describe("TS-001: determineTestStrategy returns tdd-simple for simple complexity", () => {
  test("simple + auto → tdd-simple", async () => {
    const { determineTestStrategy } = await import("../../../src/routing/router");

    const result = determineTestStrategy("simple", "Update label", "Change button copy", [], "auto");
    expect(result as string).toBe("tdd-simple");
  });

  test("simple + default tddStrategy → tdd-simple", async () => {
    const { determineTestStrategy } = await import("../../../src/routing/router");

    // tddStrategy defaults to 'auto' when omitted
    const result = determineTestStrategy("simple", "Add tooltip", "Show help text on hover", []);
    expect(result as string).toBe("tdd-simple");
  });

  test("simple + off → test-after (off disables TDD)", async () => {
    const { determineTestStrategy } = await import("../../../src/routing/router");

    const result = determineTestStrategy("simple", "Update config", "Change defaults", [], "off");
    expect(result).toBe("test-after");
  });

  test("simple + strict → three-session-tdd (strict overrides all)", async () => {
    const { determineTestStrategy } = await import("../../../src/routing/router");

    const result = determineTestStrategy("simple", "Update config", "Change defaults", [], "strict");
    expect(result).toBe("three-session-tdd");
  });

  test("tdd-simple is in the set of valid TestStrategy values", async () => {
    const { determineTestStrategy } = await import("../../../src/routing/router");

    const validStrategies = ["test-after", "tdd-simple", "three-session-tdd-lite", "three-session-tdd"];
    const result = determineTestStrategy("simple", "Add button", "A simple story", [], "auto");

    expect(validStrategies).toContain(result);
    expect(result as string).toBe("tdd-simple");
  });
});

// ---------------------------------------------------------------------------
// TS-001: LLM-derived testStrategy via validateRoutingDecision uses tdd-simple
// ---------------------------------------------------------------------------

describe("TS-001: LLM routing derives tdd-simple for simple stories", () => {
  test("validateRoutingDecision derives tdd-simple for simple complexity", async () => {
    const { validateRoutingDecision } = await import("../../../src/routing/strategies/llm-prompts");
    const { DEFAULT_CONFIG } = await import("../../../src/config/defaults");

    const story = {
      id: "TS-001",
      title: "Add submit button",
      description: "Simple UI feature",
      acceptanceCriteria: ["Button renders"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const parsed = {
      complexity: "simple",
      modelTier: "fast",
      reasoning: "Simple button addition",
    };

    const decision = validateRoutingDecision(parsed, DEFAULT_CONFIG, story);
    expect(decision.testStrategy as string).toBe("tdd-simple");
  });
});

// ---------------------------------------------------------------------------
// TS-001: LLM prompt includes tdd-simple documentation
// ---------------------------------------------------------------------------

describe("TS-001: LLM routing prompt describes tdd-simple strategy", () => {
  test("buildRoutingPrompt output mentions tdd-simple", async () => {
    const { buildRoutingPrompt } = await import("../../../src/routing/strategies/llm-prompts");
    const { DEFAULT_CONFIG } = await import("../../../src/config/defaults");

    const story = {
      id: "TS-001",
      title: "Add submit button",
      description: "Simple UI feature",
      acceptanceCriteria: ["Button renders"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const prompt = buildRoutingPrompt(story, DEFAULT_CONFIG);
    // Routing prompt focuses on complexity + model tier (test strategy is derived in code)
    expect(prompt).toContain("Complexity Levels");
    expect(prompt).toContain("Model Tiers");
    expect(prompt).toContain("simple");
    expect(prompt).toContain("complex");
  });

  test("buildRoutingPrompt does not mention test strategies (derived in code since BUG-045)", async () => {
    const { buildRoutingPrompt } = await import("../../../src/routing/strategies/llm-prompts");
    const { DEFAULT_CONFIG } = await import("../../../src/config/defaults");

    const story = {
      id: "TS-001",
      title: "Add submit button",
      description: "Simple UI feature",
      acceptanceCriteria: ["Button renders"],
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };

    const prompt = buildRoutingPrompt(story, DEFAULT_CONFIG);
    // Test strategy is derived by determineTestStrategy() in code, not by LLM
    expect(prompt).not.toContain("tdd-simple");
    expect(prompt).not.toContain("test-after");
    expect(prompt).not.toContain("three-session-tdd");
  });

  test("buildBatchRoutingPrompt uses same structure as single prompt", async () => {
    const { buildBatchRoutingPrompt } = await import("../../../src/routing/strategies/llm-prompts");
    const { DEFAULT_CONFIG } = await import("../../../src/config/defaults");

    const stories = [
      {
        id: "TS-001",
        title: "Add submit button",
        description: "Simple UI feature",
        acceptanceCriteria: ["Button renders"],
        tags: [],
        dependencies: [],
        status: "pending" as const,
        passes: false,
        escalations: [],
        attempts: 0,
      },
    ];

    const prompt = buildBatchRoutingPrompt(stories, DEFAULT_CONFIG);
    expect(prompt).toContain("Complexity Levels");
    expect(prompt).toContain("Model Tiers");
    expect(prompt).not.toContain("tdd-simple");
  });
});
