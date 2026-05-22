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
  test("includes all criteria strings, codebase context, and returns non-empty string", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);
    for (const criterion of SAMPLE_CRITERIA) {
      expect(prompt).toContain(criterion);
    }
    expect(prompt).toContain(CODEBASE_CONTEXT);
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("works with empty criteria list or empty codebase context", () => {
    expect(typeof buildRefinementPrompt([], CODEBASE_CONTEXT)).toBe("string");
    const promptNoCtx = buildRefinementPrompt(SAMPLE_CRITERIA, "");
    for (const criterion of SAMPLE_CRITERIA) {
      expect(promptNoCtx).toContain(criterion);
    }
  });

  test("omits CODEBASE CONTEXT section when empty; includes it when provided", () => {
    expect(buildRefinementPrompt(SAMPLE_CRITERIA, "")).not.toContain("CODEBASE CONTEXT:");
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);
    expect(prompt).toContain("CODEBASE CONTEXT:");
    expect(prompt).toContain(CODEBASE_CONTEXT);
  });

  test("STORY CONTEXT: present with title/description; absent when neither provided", () => {
    const withTitle = buildRefinementPrompt(SAMPLE_CRITERIA, "", { storyTitle: "Export tasks to CSV" });
    expect(withTitle).toContain("STORY CONTEXT:");
    expect(withTitle).toContain("Export tasks to CSV");

    const withDesc = buildRefinementPrompt(SAMPLE_CRITERIA, "", {
      storyTitle: "Export tasks to CSV",
      storyDescription: "As a user, I can call exportTasks() to get a file",
    });
    expect(withDesc).toContain("As a user, I can call exportTasks() to get a file");

    expect(buildRefinementPrompt(SAMPLE_CRITERIA, "")).not.toContain("STORY CONTEXT:");
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
  test("parses valid JSON response — correct length, original, refined, testable, storyId fields", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
      expect(typeof result[i].refined).toBe("string");
      expect(result[i].refined.length).toBeGreaterThan(0);
      expect(typeof result[i].testable).toBe("boolean");
      expect(typeof result[i].storyId).toBe("string");
      expect(result[i].storyId.length).toBeGreaterThan(0);
    }
  });

  test("falls back to original text on malformed or empty JSON; preserves testable:false from valid JSON; fallback defaults testable:true", () => {
    const malformed = parseRefinementResponse("this is not valid JSON {{{", SAMPLE_CRITERIA);
    expect(Array.isArray(malformed)).toBe(true);
    expect(malformed).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(malformed[i].original).toBe(SAMPLE_CRITERIA[i]);
      expect(malformed[i].refined).toBe(SAMPLE_CRITERIA[i]);
    }

    const empty = parseRefinementResponse("", SAMPLE_CRITERIA);
    expect(empty).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(empty[i].original).toBe(SAMPLE_CRITERIA[i]);
    }

    const falseTestable = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID, false).output, SAMPLE_CRITERIA);
    for (const item of falseTestable) {
      expect(item.testable).toBe(false);
    }

    const fallback = parseRefinementResponse("invalid json", SAMPLE_CRITERIA);
    for (const item of fallback) {
      expect(item.testable).toBe(true);
    }
  });
});

describe("buildRefinementPrompt — strategy-specific instructions", () => {
  test.each([
    ["component", "rendered output visible on screen"],
    ["cli", "stdout"],
    ["e2e", "HTTP response"],
  ] as const)("includes %s strategy instructions", (strategy, keyword) => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", { testStrategy: strategy });
    expect(prompt).toContain(`TEST STRATEGY: ${strategy}`);
    expect(prompt).toContain(keyword);
  });

  test("omits TEST STRATEGY when omitted; includes testFramework when provided; defaults to framework-only hint for unknown strategy", () => {
    expect(buildRefinementPrompt(SAMPLE_CRITERIA, "")).not.toContain("TEST STRATEGY:");
    expect(
      buildRefinementPrompt(SAMPLE_CRITERIA, "", { testStrategy: "component", testFramework: "ink-testing-library" }),
    ).toContain("ink-testing-library");
    expect(
      buildRefinementPrompt(SAMPLE_CRITERIA, "", { testStrategy: "snapshot", testFramework: "jest" }),
    ).toContain("TEST FRAMEWORK: jest");
  });
});
