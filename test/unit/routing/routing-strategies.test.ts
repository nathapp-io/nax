// RE-ARCH: keep
/**
 * LLM Routing Strategy Tests
 *
 * Tests for LLM routing utilities:
 * - Prompt building (buildRoutingPrompt, buildBatchPrompt)
 * - Response parsing (parseRoutingResponse)
 * - Code fence handling (stripCodeFences)
 * - Decision validation (validateRoutingDecision)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { UserStory } from "../../../src/prd/types";
import {
  buildBatchPrompt,
  buildRoutingPrompt,
  parseRoutingResponse,
  stripCodeFences,
  validateRoutingDecision,
} from "../../../src/routing/strategies/llm";

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

describe("LLM Routing Strategy - Prompt Building", () => {
  test("buildRoutingPrompt formats story correctly", () => {
    const prompt = buildRoutingPrompt(simpleStory, DEFAULT_CONFIG);

    expect(prompt).toContain("Title: Fix typo in README");
    expect(prompt).toContain("Description: Correct spelling mistake");
    expect(prompt).toContain("1. Update README.md with correct spelling");
    expect(prompt).toContain("Tags: docs");
    expect(prompt).toContain("fast: For simple tasks");
    expect(prompt).toContain("balanced: For medium tasks");
    expect(prompt).toContain("powerful: For complex/expert tasks");
  });

  test("buildBatchPrompt formats multiple stories", () => {
    const stories = [simpleStory, complexStory];
    const prompt = buildBatchPrompt(stories, DEFAULT_CONFIG);

    expect(prompt).toContain("1. US-001: Fix typo in README");
    expect(prompt).toContain("2. US-002: Add JWT authentication");
    expect(prompt).toContain("Tags: docs");
    expect(prompt).toContain("Tags: security, auth");
    expect(prompt).toContain('{"id":"US-001"');
  });
});

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
