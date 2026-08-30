// RE-ARCH: keep
/**
 * LLM Routing Strategy Tests
 *
 * Tests for LLM routing utilities:
 * - Response parsing (parseRoutingResponse)
 * - Code fence handling (stripCodeFences)
 * - Decision validation (validateRoutingDecision)
 *
 * Note: Prompt-building tests (buildRoutingPrompt, buildBatchPrompt) were
 * parity tests removed in Phase 6 when prompts migrated to OneShotPromptBuilder.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import type { UserStory } from "@/prd/types";
import { parseRoutingResponse, stripCodeFences, validateRoutingDecision } from "@/routing/strategies/llm";
import { parseBatchResponse } from "@/routing/strategies/llm-parsing";

const simpleStory: UserStory = {
  id: "US-001",
  title: "Fix typo in README",
  description: "Correct spelling mistake",
  acceptanceCriteria: ["Update README.md with correct spelling"],
  tags: ["docs"],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

const complexStory: UserStory = {
  id: "US-002",
  title: "Add JWT authentication",
  description: "Implement JWT authentication with refresh tokens",
  acceptanceCriteria: ["Secure token storage", "Token refresh endpoint", "Expiry handling", "Logout functionality"],
  tags: ["security", "auth"],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

describe("LLM Routing Strategy - Response Parsing", () => {
  test("parseRoutingResponse handles valid JSON", () => {
    const output =
      '{"complexity":"simple","modelTier":"fast","testStrategy":"test-after","reasoning":"Simple documentation fix"}';
    const decision = parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG);

    expect(decision.complexity).toBe("simple");
    expect(decision.modelTier).toBe("fast");
    expect(decision.testStrategy).toBe("tdd-simple");
    expect(decision.reasoning).toBe("Simple documentation fix");
  });

  test("parseRoutingResponse strips markdown code blocks", () => {
    const output =
      '```json\n{"complexity":"complex","modelTier":"powerful","testStrategy":"three-session-tdd","reasoning":"Security-critical"}\n```';
    const decision = parseRoutingResponse(output, complexStory, DEFAULT_CONFIG);

    expect(decision.complexity).toBe("complex");
    expect(decision.modelTier).toBe("powerful");
    expect(decision.testStrategy).toBe("three-session-tdd");
  });

  test("parseRoutingResponse throws on invalid JSON", () => {
    const output = "This is not JSON";
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow();
  });

  test("parseRoutingResponse throws on missing fields", () => {
    const output = '{"complexity":"simple","modelTier":"fast"}';
    expect(() => parseRoutingResponse(output, simpleStory, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });
});

describe("stripCodeFences", () => {
  test("returns plain JSON unchanged", () => {
    const input = '{"complexity":"simple"}';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("strips ```json ... ``` fences", () => {
    const input = '```json\n{"complexity":"simple"}\n```';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });

  test("strips leading 'json' keyword (no backticks)", () => {
    const input = 'json\n{"complexity":"simple"}';
    expect(stripCodeFences(input)).toBe('{"complexity":"simple"}');
  });
});

describe("validateRoutingDecision", () => {
  test("returns valid decision for correct input", () => {
    const input = { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "trivial" };
    const result = validateRoutingDecision(input, DEFAULT_CONFIG);
    expect(result).toEqual({
      complexity: "simple",
      modelTier: "fast",
      testStrategy: "tdd-simple",
      reasoning: "trivial",
    });
  });

  test("throws on missing complexity", () => {
    const input = { modelTier: "fast", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Missing required fields");
  });

  test("throws on invalid complexity value", () => {
    const input = { complexity: "mega", modelTier: "fast", testStrategy: "test-after", reasoning: "test" };
    expect(() => validateRoutingDecision(input, DEFAULT_CONFIG)).toThrow("Invalid complexity: mega");
  });
});

describe("parseBatchResponse", () => {
  test("parses a batch of valid decisions keyed by story id", () => {
    const output = JSON.stringify([
      { id: "US-001", complexity: "simple", modelTier: "fast", reasoning: "trivial fix" },
      { id: "US-002", complexity: "complex", modelTier: "powerful", reasoning: "security-critical" },
    ]);

    const decisions = parseBatchResponse(output, [simpleStory, complexStory], DEFAULT_CONFIG);

    expect(decisions.size).toBe(2);
    expect(decisions.get("US-001")?.complexity).toBe("simple");
    expect(decisions.get("US-002")?.complexity).toBe("complex");
  });

  test("throws when the response is not a JSON array", () => {
    const output = JSON.stringify({ id: "US-001", complexity: "simple", modelTier: "fast", reasoning: "x" });
    expect(() => parseBatchResponse(output, [simpleStory], DEFAULT_CONFIG)).toThrow(
      "Batch LLM response must be a JSON array",
    );
  });

  test("throws when an entry is missing an id", () => {
    const output = JSON.stringify([{ complexity: "simple", modelTier: "fast", reasoning: "x" }]);
    expect(() => parseBatchResponse(output, [simpleStory], DEFAULT_CONFIG)).toThrow("Batch entry missing 'id' field");
  });

  test("throws when an entry references an unknown story id", () => {
    const output = JSON.stringify([{ id: "US-999", complexity: "simple", modelTier: "fast", reasoning: "x" }]);
    expect(() => parseBatchResponse(output, [simpleStory], DEFAULT_CONFIG)).toThrow(
      "Batch entry has unknown story ID: US-999",
    );
  });
});
