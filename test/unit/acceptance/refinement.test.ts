/**
 * Tests for src/acceptance/refinement.ts — AC refinement parser (ACC-001)
 *
 * Covers:
 * - parseRefinementResponse handles valid JSON response correctly
 * - parseRefinementResponse falls back to original text on malformed JSON
 * - Criteria marked testable:false are preserved but flagged
 */

import { describe, expect, test } from "bun:test";
import { parseRefinementResponse } from "../../../src/acceptance/refinement";
import { AcceptancePromptBuilder } from "../../../src/prompts";
import type { RefinedCriterion } from "../../../src/acceptance/types";

const buildRefinementPrompt = (
  criteria: string[],
  ctx: string,
  opts?: Parameters<AcceptancePromptBuilder["buildRefinementPrompt"]>[2],
) => new AcceptancePromptBuilder().buildRefinementPrompt(criteria, ctx, opts);

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const STORY_ID = "ACC-001";

const SAMPLE_CRITERIA = [
  "refineAcceptanceCriteria returns RefinedCriterion[] with original and refined fields",
  "buildRefinementPrompt includes all criteria and codebase context in output",
  "parseRefinementResponse handles valid JSON response correctly",
];

const CODEBASE_CONTEXT = "File tree:\nsrc/\n  acceptance/\n    refinement.ts\n";

/** Build a valid LLM JSON response for the given criteria, wrapped as CompleteResult */
function makeLLMResponse(criteria: string[], storyId: string, testable = true): { output: string } {
  const items: RefinedCriterion[] = criteria.map((c) => ({
    original: c,
    refined: `Verify that: ${c}`,
    testable,
    storyId,
  }));
  return { output: JSON.stringify(items) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRefinementPrompt", () => {
  test("includes all criteria strings in the output", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    for (const criterion of SAMPLE_CRITERIA) {
      expect(prompt).toContain(criterion);
    }
  });

  test("includes codebase context in the output", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    expect(prompt).toContain(CODEBASE_CONTEXT);
  });

  test("returns a non-empty string", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("works with empty criteria list", () => {
    const prompt = buildRefinementPrompt([], CODEBASE_CONTEXT);

    expect(typeof prompt).toBe("string");
  });

  test("works with empty codebase context", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "");

    for (const criterion of SAMPLE_CRITERIA) {
      expect(prompt).toContain(criterion);
    }
  });

  test("omits CODEBASE CONTEXT section when codebaseContext is empty", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "");
    expect(prompt).not.toContain("CODEBASE CONTEXT:");
  });

  test("includes CODEBASE CONTEXT section when codebaseContext is provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);
    expect(prompt).toContain("CODEBASE CONTEXT:");
    expect(prompt).toContain(CODEBASE_CONTEXT);
  });

  test("includes STORY CONTEXT section when storyTitle is provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", { storyTitle: "Export tasks to CSV" });
    expect(prompt).toContain("STORY CONTEXT:");
    expect(prompt).toContain("Export tasks to CSV");
  });

  test("includes storyDescription in STORY CONTEXT when provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", {
      storyTitle: "Export tasks to CSV",
      storyDescription: "As a user, I can call exportTasks() to get a file",
    });
    expect(prompt).toContain("As a user, I can call exportTasks() to get a file");
  });

  test("omits STORY CONTEXT section when neither storyTitle nor storyDescription is provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "");
    expect(prompt).not.toContain("STORY CONTEXT:");
  });

  test("STORY CONTEXT appears before CODEBASE CONTEXT in the prompt", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      storyTitle: "Export tasks to CSV",
    });
    const storyIdx = prompt.indexOf("STORY CONTEXT:");
    const codebaseIdx = prompt.indexOf("CODEBASE CONTEXT:");
    expect(storyIdx).toBeGreaterThanOrEqual(0);
    expect(codebaseIdx).toBeGreaterThan(storyIdx);
  });
});

describe("parseRefinementResponse", () => {
  test("parses valid JSON response into RefinedCriterion[]", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
  });

  test("each result has original field matching input criteria", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("each result has a non-empty refined field", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(typeof item.refined).toBe("string");
      expect(item.refined.length).toBeGreaterThan(0);
    }
  });

  test("each result has a boolean testable field", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(typeof item.testable).toBe("boolean");
    }
  });

  test("each result has a storyId field", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(typeof item.storyId).toBe("string");
      expect(item.storyId.length).toBeGreaterThan(0);
    }
  });

  test("falls back to original text on malformed JSON", () => {
    const result = parseRefinementResponse("this is not valid JSON {{{", SAMPLE_CRITERIA);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
      expect(result[i].refined).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("falls back to original text on empty response", () => {
    const result = parseRefinementResponse("", SAMPLE_CRITERIA);

    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("preserves testable:false items from valid JSON response", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID, false).output, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(item.testable).toBe(false);
    }
  });

  test("fallback items have testable:true by default", () => {
    const result = parseRefinementResponse("invalid json", SAMPLE_CRITERIA);

    for (const item of result) {
      expect(item.testable).toBe(true);
    }
  });
});

describe("buildRefinementPrompt — strategy-specific instructions", () => {
  test("includes component strategy instructions when testStrategy is 'component'", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", { testStrategy: "component" });
    expect(prompt).toContain("TEST STRATEGY: component");
    expect(prompt).toContain("rendered output visible on screen");
  });

  test("includes cli strategy instructions when testStrategy is 'cli'", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", { testStrategy: "cli" });
    expect(prompt).toContain("TEST STRATEGY: cli");
    expect(prompt).toContain("stdout");
  });

  test("includes e2e strategy instructions when testStrategy is 'e2e'", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", { testStrategy: "e2e" });
    expect(prompt).toContain("TEST STRATEGY: e2e");
    expect(prompt).toContain("HTTP response");
  });

  test("omits strategy instructions when testStrategy is omitted", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "");
    expect(prompt).not.toContain("TEST STRATEGY:");
  });

  test("includes testFramework in prompt when provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", {
      testStrategy: "component",
      testFramework: "ink-testing-library",
    });
    expect(prompt).toContain("ink-testing-library");
  });

  test("defaults to framework-only hint for unknown strategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", { testStrategy: "snapshot", testFramework: "jest" });
    expect(prompt).toContain("TEST FRAMEWORK: jest");
  });
});
