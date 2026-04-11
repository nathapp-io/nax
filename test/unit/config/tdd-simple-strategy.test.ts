/**
 * TS-001: tdd-simple TestStrategy type and router validation
 *
 * Failing tests (RED phase):
 * - TestStrategy type includes 'tdd-simple'
 * - determineTestStrategy returns tdd-simple for simple complexity in auto mode
 * - test-after is only returned when tddStrategy is 'off'
 *
 * Note: Prompt-building tests (buildRoutingPrompt, buildBatchRoutingPrompt) were
 * parity tests removed in Phase 6 when prompts migrated to OneShotPromptBuilder.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { initLogger, resetLogger } from "../../../src/logger";
import { determineTestStrategy } from "../../../src/routing/classify";
import { validateRoutingDecision } from "../../../src/routing/strategies/llm";

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
  test("simple + auto → tdd-simple", () => {
    const result = determineTestStrategy("simple", "Update label", "Change button copy", [], "auto");
    expect(result as string).toBe("tdd-simple");
  });

  test("simple + default tddStrategy → tdd-simple", () => {
    // tddStrategy defaults to 'auto' when omitted
    const result = determineTestStrategy("simple", "Add tooltip", "Show help text on hover", []);
    expect(result as string).toBe("tdd-simple");
  });

  test("simple + off → test-after (off disables TDD)", () => {
    const result = determineTestStrategy("simple", "Update config", "Change defaults", [], "off");
    expect(result).toBe("test-after");
  });

  test("simple + strict → three-session-tdd (strict overrides all)", () => {
    const result = determineTestStrategy("simple", "Update config", "Change defaults", [], "strict");
    expect(result).toBe("three-session-tdd");
  });

  test("tdd-simple is in the set of valid TestStrategy values", () => {
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
  test("validateRoutingDecision derives tdd-simple for simple complexity", () => {
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

