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
import type { Iteration } from "@/findings";
import { ReviewPromptBuilder } from "@/prompts";
import { SEMANTIC_CATEGORIES, SEMANTIC_CATEGORY_ENUM_LINE } from "@/review/semantic-categories";
import type { SemanticReviewConfig, SemanticStory } from "@/review/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "US-001",
  title: "Add semantic review",
  description: "Implement LLM-based semantic review for story diffs.",
  acceptanceCriteria: ["LLM is called with story diff", "Findings are returned as structured JSON"],
};

const CONFIG_NO_RULES: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  substantiation: { requote: true, maxRequotes: 5 },
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
    test("includes story title, description, and numbered acceptance criteria", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain(`## Story: ${STORY.title}`);
      expect(result).toContain(STORY.description);
      expect(result).toContain("1. LLM is called with story diff");
      expect(result).toContain("2. Findings are returned as structured JSON");
    });
  });

  describe("custom rules", () => {
    test("omitted when rules empty; included and numbered when rules are present", () => {
      expect(builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF })).not.toContain(
        "## Additional Review Rules",
      );

      const withRules = builder.buildSemanticReviewPrompt(STORY, CONFIG_WITH_RULES, { mode: "embedded", diff: DIFF });
      expect(withRules).toContain("## Additional Review Rules");
      expect(withRules).toContain("1. Do not flag style issues");
      expect(withRules).toContain("2. Verify AC 1 using GREP before flagging");
    });
  });

  describe("diff block", () => {
    test("diff is included verbatim in a fenced code block", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain(`\`\`\`diff\n${DIFF}`);
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

  describe("role declaration and instructions block", () => {
    test("role, tool-verification, style exclusion, verifiedBy verbatim, AC-grounding requirements", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain("You are a semantic code reviewer");
      expect(result).toContain("Test coverage gaps and convention/lint issues are out of scope");
      expect(result).toContain("you MUST verify it using your tools");
      expect(result).toContain("Do NOT flag: style issues");
      // #826 — observed must be verbatim excerpt
      expect(result).toContain("verbatim");
      expect(result).toMatch(/observed.*(verbatim|copy-pasted|exact)/i);
      expect(result).toContain("not a description");
      expect(result).not.toContain("verbatim substring");
      expect(result).not.toContain("copy backticks exactly");
      expect(result).not.toContain("AC names the file but not the symbol");
      expect(result).toContain("acIndex");
      expect(result).toContain("acQuote");
    });
  });

  describe("category taxonomy (audit rec #6)", () => {
    test("output schema requires a category, rendered from the SSOT enum", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain(`"category": ${SEMANTIC_CATEGORY_ENUM_LINE}`);
      for (const category of SEMANTIC_CATEGORIES) {
        expect(result).toContain(`"${category}"`);
      }
    });

    test("each category is defined for the reviewer, so the axis is picked deliberately", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).toContain("Finding categories");
      for (const category of SEMANTIC_CATEGORIES) {
        expect(result).toMatch(new RegExp(`\`${category}\`\\s+—`));
      }
    });

    test("does not offer adversarial-owned categories that are out of semantic scope", () => {
      const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF });
      expect(result).not.toContain('"test-gap"');
      expect(result).not.toContain('"convention"');
    });
  });
});

describe("ReviewPromptBuilder.buildSemanticReviewPrompt() — priorSemanticIterations", () => {
  const builder = new ReviewPromptBuilder();

  test("omits prior iterations block when undefined or empty; includes it when entries present", () => {
    expect(builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, { mode: "embedded", diff: DIFF })).not.toContain(
      "## Prior Iterations",
    );
    expect(
      builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, {
        mode: "embedded",
        diff: DIFF,
        priorSemanticIterations: [],
      }),
    ).not.toContain("## Prior Iterations");
  });

  test("includes prior iterations block with round header and finding text when priorSemanticIterations has entries", () => {
    const iteration: Iteration = {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: [],
      findingsAfter: [
        { source: "semantic-review", message: "AC 2 not wired", severity: "error", category: "ac-coverage" },
      ],
      outcome: "partial",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    };
    const result = builder.buildSemanticReviewPrompt(STORY, CONFIG_NO_RULES, {
      mode: "embedded",
      diff: DIFF,
      priorSemanticIterations: [iteration],
    });
    expect(result).toContain("## Prior Iterations — verdict required before new analysis");
    expect(result).toContain("### Round 1 — outcome: partial");
    expect(result).toContain("(0 → 1)");
    // Finding text rendered verbatim — not a count-category summary
    expect(result).toContain("AC 2 not wired");
  });
});

describe("ReviewPromptBuilder.jsonRetryCondensed()", () => {
  test("error/warning/info thresholds produce correct include-all + cap text", () => {
    const error = ReviewPromptBuilder.jsonRetryCondensed();
    expect(error).toContain('Include ALL findings with severity "error"');
    expect(error).toContain("at most 3 additional findings");
    expect(error).toContain("Output ONLY a complete, valid JSON object");

    const warning = ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: "warning" });
    expect(warning).toContain('Include ALL findings with severity "error" and "warning"');
    expect(warning).toContain("at most 3 additional findings");

    const info = ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: "info" });
    expect(info).toContain("Include ALL findings — do not drop any by severity.");
    expect(info).not.toContain("at most 3 additional findings");
    expect(info).toContain("prioritize the highest-severity findings first");
  });

  test("custom advisoryCap and zero advisoryCap are honored", () => {
    expect(ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: "error", advisoryCap: 5 })).toContain(
      "at most 5 additional findings",
    );
    const zero = ReviewPromptBuilder.jsonRetryCondensed({ blockingThreshold: "error", advisoryCap: 0 });
    expect(zero).toContain('Include ALL findings with severity "error"');
    expect(zero).toContain("at most 0 additional findings");
  });

  test("condensed retry schema includes verifiedBy (Bug 4 fix: verifiedBy must not be dropped)", () => {
    const result = ReviewPromptBuilder.jsonRetryCondensed();
    expect(result).toContain('"verifiedBy"');
    expect(result).toContain('"observed"');
  });
});

describe("ReviewPromptBuilder.requoteVerbatim()", () => {
  test("asks for JSON-only verbatim requote with original finding context", () => {
    const result = ReviewPromptBuilder.requoteVerbatim({
      finding: {
        severity: "error",
        file: "src/foo.ts",
        line: 42,
        issue: "Missing guard",
        suggestion: "Add guard",
        verifiedBy: {
          file: "src/foo.ts",
          line: 42,
          observed: "described the issue instead of quoting it",
        },
      },
    });
    expect(result).toContain("did not match the referenced file on disk");
    expect(result).toContain('"file":"src/foo.ts"');
    expect(result).toContain('"line":42');
    expect(result).toContain('observed":"exact 1-3 line quote');
    expect(result).toContain('set observed to ""');
    expect(result).toContain("Do not return a full review");
  });

  test("forces a file-read tool call and omits the prior observed value", () => {
    const result = ReviewPromptBuilder.requoteVerbatim({
      finding: {
        severity: "error",
        file: "src/foo.ts",
        line: 42,
        issue: "Missing guard",
        suggestion: "Add guard",
        verifiedBy: {
          file: "src/foo.ts",
          line: 42,
          observed: "hallucinated quote that was rejected",
        },
      },
    });
    // The previous observed must not be echoed back — that was the regurgitation
    // surface that let the model re-emit the same wrong quote (observed in a real
    // run: opencode semantic requote returning toolCallUpdates=0 and the same
    // hallucinated string).
    expect(result).not.toContain("hallucinated quote that was rejected");
    expect(result).not.toContain("Previous observed");
    // The prompt must demand an actual file-read tool call.
    expect(result).toMatch(/file-reading tool|file tool/);
    expect(result).toMatch(/quote from memory/i);
  });
});

// ─── Feature-level out-of-scope rendering ─────────────────────────────────────
// Reviewers hand-render their own story block (not via buildStorySection), so
// this is the only path by which the propagated story.outOfScope list reaches
// them. The numbering is load-bearing: scopeIndex is a 1-based index into it.

const OUT_OF_SCOPE = ["An interactive Ink TUI", "Per-story diffs or checkpoints"];

function makeScopeStory(outOfScope?: string[]): SemanticStory {
  return {
    id: "US-001",
    title: "Reconstruct the run timeline",
    description: "Build the replay core.",
    acceptanceCriteria: ["When a run id is given, then a RunTimeline is returned"],
    ...(outOfScope ? { outOfScope } : {}),
  };
}

function semanticPrompt(story: SemanticStory): string {
  return new ReviewPromptBuilder().buildSemanticReviewPrompt(
    story,
    { model: "balanced", diffMode: "ref", rules: [] } as unknown as SemanticReviewConfig,
    { mode: "ref", storyGitRef: "abc123", stat: " src/a.ts | 2 +-" },
  );
}

describe("semantic review prompt", () => {
  test("includes the numbered out-of-scope list", () => {
    const prompt = semanticPrompt(makeScopeStory(OUT_OF_SCOPE));
    expect(prompt).toContain("Out of Scope (feature-level — NOT acceptance criteria)");
    expect(prompt).toContain("1. An interactive Ink TUI");
  });

  test("keeps exclusions out of the acceptance-criteria list", () => {
    const prompt = semanticPrompt(makeScopeStory(OUT_OF_SCOPE));
    const acIndex = prompt.indexOf("### Acceptance Criteria");
    const oosIndex = prompt.indexOf("Out of Scope (feature-level");
    expect(acIndex).toBeGreaterThan(-1);
    expect(oosIndex).toBeGreaterThan(acIndex);
  });

  test("omits the block when the story declares no exclusions", () => {
    expect(semanticPrompt(makeScopeStory())).not.toContain("Out of Scope (feature-level");
  });
});
