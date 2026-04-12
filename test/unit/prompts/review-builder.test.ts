/**
 * Tests for ReviewPromptBuilder (Phase 3)
 *
 * Covers:
 * - buildSemanticReviewPrompt: snapshot stability + structural contract
 * - Story block: title, description, numbered ACs
 * - Custom rules: included when present, omitted when empty
 * - Diff block: fenced verbatim in the prompt
 * - JSON wrapping: wrapJsonPrompt framing applied
 */

import { describe, expect, test } from "bun:test";
import { ReviewPromptBuilder } from "../../../src/prompts";
import type { SemanticReviewConfig, SemanticStory } from "../../../src/review/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "US-001",
  title: "Add semantic review",
  description: "Implement LLM-based semantic review for story diffs.",
  acceptanceCriteria: ["LLM is called with story diff", "Findings are returned as structured JSON"],
};

const CONFIG_NO_RULES: SemanticReviewConfig = {
  modelTier: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [],
};

const CONFIG_WITH_RULES: SemanticReviewConfig = {
  ...CONFIG_NO_RULES,
  rules: ["Do not flag style issues", "Verify AC 1 using GREP before flagging"],
};

const DIFF = `diff --git a/src/review/semantic.ts b/src/review/semantic.ts
+export async function runSemanticReview() {}`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ReviewPromptBuilder.buildSemanticReviewPrompt()", () => {
  const builder = new ReviewPromptBuilder();

  describe("snapshot stability", () => {
    test("no custom rules — output is stable", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toMatchSnapshot();
    });

    test("with custom rules — output is stable", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_WITH_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toMatchSnapshot();
    });
  });

  describe("story block", () => {
    test("includes story title", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain(`## Story: ${STORY.title}`);
    });

    test("includes story description", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain(STORY.description);
    });

    test("numbers acceptance criteria", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain("1. LLM is called with story diff");
      expect(result).toContain("2. Findings are returned as structured JSON");
    });
  });

  describe("custom rules", () => {
    test("omitted when rules array is empty", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).not.toContain("## Additional Review Rules");
    });

    test("included and numbered when rules are present", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_WITH_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain("## Additional Review Rules");
      expect(result).toContain("1. Do not flag style issues");
      expect(result).toContain("2. Verify AC 1 using GREP before flagging");
    });
  });

  describe("diff block", () => {
    test("diff is included verbatim in a fenced code block", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain("```diff\n" + DIFF);
    });
  });

  describe("JSON wrapping", () => {
    test("applies wrapJsonPrompt framing", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      // wrapJsonPrompt prepends and appends sentinel strings
      expect(result).toContain("IMPORTANT: Your entire response must be a single JSON object or array");
      expect(result).toContain("YOUR RESPONSE MUST START WITH { OR [");
    });
  });

  describe("role declaration", () => {
    test("includes semantic reviewer role", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain("You are a semantic code reviewer");
      expect(result).toContain("NOT a linter or style checker");
    });
  });

  describe("instructions block", () => {
    test("includes tool-verification requirement", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain("you MUST verify it using your tools");
    });

    test("instructs not to flag style issues", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain("Do NOT flag: style issues");
    });
  });
});
