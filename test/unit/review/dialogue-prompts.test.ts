/**
 * Unit tests for src/review/dialogue-prompts.ts
 *
 * Covers:
 * - buildReviewPrompt() — extracted from dialogue.ts; regression check
 * - buildReReviewPrompt() — extracted from dialogue.ts; regression check
 * - buildDebateResolverPrompt() — varies by resolver type
 * - buildDebateReReviewPrompt() — references previous findings
 */

import { describe, expect, test } from "bun:test";
import {
  buildDebateReReviewPrompt,
  buildDebateResolverPrompt,
  buildReReviewPrompt,
  buildReviewPrompt,
} from "../../../src/review/dialogue-prompts";
import type { DebateResolverContext } from "../../../src/review/dialogue-prompts";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { ReviewFinding } from "../../../src/plugins/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-001",
  title: "Add debate resolver dialogue",
  description: "Wire resolvers to use ReviewerSession",
  acceptanceCriteria: ["AC-1: resolveDebate() works", "AC-2: reReviewDebate() references prior findings"],
};

const SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [],
};

const DIFF = "diff --git a/src/foo.ts b/src/foo.ts\n+export function foo() {}";

const FINDING: ReviewFinding = {
  ruleId: "missing-ac",
  severity: "error",
  file: "src/foo.ts",
  line: 1,
  message: "AC-1 not satisfied",
};

const PROPOSALS: Array<{ debater: string; output: string }> = [
  { debater: "claude", output: '{"passed": false, "findings": []}' },
  { debater: "opencode", output: '{"passed": true, "findings": []}' },
];

const CRITIQUES = ["Proposal 1 missed edge case X", "Proposal 2 looks good"];

// ---------------------------------------------------------------------------
// buildReviewPrompt — regression
// ---------------------------------------------------------------------------

describe("buildReviewPrompt", () => {
  test("includes story id and title", () => {
    const prompt = buildReviewPrompt(DIFF, STORY, SEMANTIC_CONFIG);
    expect(prompt).toContain("US-001");
    expect(prompt).toContain("Add debate resolver dialogue");
  });

  test("includes acceptance criteria", () => {
    const prompt = buildReviewPrompt(DIFF, STORY, SEMANTIC_CONFIG);
    expect(prompt).toContain("AC-1: resolveDebate() works");
    expect(prompt).toContain("AC-2: reReviewDebate() references prior findings");
  });

  test("includes the diff", () => {
    const prompt = buildReviewPrompt(DIFF, STORY, SEMANTIC_CONFIG);
    expect(prompt).toContain(DIFF);
  });

  test("asks for JSON response", () => {
    const prompt = buildReviewPrompt(DIFF, STORY, SEMANTIC_CONFIG);
    expect(prompt).toContain("passed");
    expect(prompt).toContain("findings");
  });
});

// ---------------------------------------------------------------------------
// buildReReviewPrompt — regression
// ---------------------------------------------------------------------------

describe("buildReReviewPrompt", () => {
  test("includes 'follow-up' framing", () => {
    const prompt = buildReReviewPrompt(DIFF, [FINDING]);
    expect(prompt).toContain("follow-up");
  });

  test("includes previous findings", () => {
    const prompt = buildReReviewPrompt(DIFF, [FINDING]);
    expect(prompt).toContain("missing-ac");
    expect(prompt).toContain("AC-1 not satisfied");
  });

  test("shows (none) when no previous findings", () => {
    const prompt = buildReReviewPrompt(DIFF, []);
    expect(prompt).toContain("(none)");
  });

  test("includes updated diff", () => {
    const prompt = buildReReviewPrompt(DIFF, [FINDING]);
    expect(prompt).toContain(DIFF);
  });

  test("asks for deltaSummary in JSON", () => {
    const prompt = buildReReviewPrompt(DIFF, [FINDING]);
    expect(prompt).toContain("deltaSummary");
  });
});

// ---------------------------------------------------------------------------
// buildDebateResolverPrompt — varies by resolver type
// ---------------------------------------------------------------------------

describe("buildDebateResolverPrompt", () => {
  test("includes labeled debater proposals", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt).toContain("claude");
    expect(prompt).toContain("opencode");
    expect(prompt).toContain(PROPOSALS[0].output);
    expect(prompt).toContain(PROPOSALS[1].output);
  });

  test("includes critiques when present", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt).toContain(CRITIQUES[0]);
  });

  test("omits critiques section when empty", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, [], DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt).not.toContain("Critiques");
  });

  test("includes diff", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt).toContain(DIFF);
  });

  test("includes acceptance criteria", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt).toContain("AC-1: resolveDebate() works");
  });

  test("synthesis type: instructs to synthesize", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt.toLowerCase()).toContain("synthes");
  });

  test("custom type: instructs judge framing", () => {
    const ctx: DebateResolverContext = { resolverType: "custom" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt.toLowerCase()).toContain("judge");
  });

  test("majority-fail-closed: includes vote tally in prompt", () => {
    const ctx: DebateResolverContext = {
      resolverType: "majority-fail-closed",
      majorityVote: { passed: false, passCount: 1, failCount: 1 },
    };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt).toContain("1 passed");
    expect(prompt).toContain("1 failed");
  });

  test("majority-fail-open: includes vote tally and fail-open note", () => {
    const ctx: DebateResolverContext = {
      resolverType: "majority-fail-open",
      majorityVote: { passed: true, passCount: 2, failCount: 0 },
    };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt).toContain("2 passed");
  });

  test("asks for JSON response with passed + findings", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    expect(prompt).toContain("passed");
    expect(prompt).toContain("findings");
  });

  test("instructs tool verification", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateResolverPrompt(PROPOSALS, CRITIQUES, DIFF, STORY, SEMANTIC_CONFIG, ctx);
    // Should instruct the reviewer to verify claims with tools
    expect(prompt.toLowerCase()).toMatch(/verif|tool/);
  });
});

// ---------------------------------------------------------------------------
// buildDebateReReviewPrompt — references prior findings
// ---------------------------------------------------------------------------

describe("buildDebateReReviewPrompt", () => {
  test("includes 're-review' or 'follow-up' framing", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateReReviewPrompt(PROPOSALS, CRITIQUES, DIFF, [FINDING], ctx);
    expect(prompt.toLowerCase()).toMatch(/re-review|follow-up|previous finding/);
  });

  test("includes previous findings", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateReReviewPrompt(PROPOSALS, CRITIQUES, DIFF, [FINDING], ctx);
    expect(prompt).toContain("missing-ac");
    expect(prompt).toContain("AC-1 not satisfied");
  });

  test("shows (none) when no previous findings", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateReReviewPrompt(PROPOSALS, CRITIQUES, DIFF, [], ctx);
    expect(prompt).toContain("(none)");
  });

  test("includes updated diff", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateReReviewPrompt(PROPOSALS, CRITIQUES, DIFF, [FINDING], ctx);
    expect(prompt).toContain(DIFF);
  });

  test("includes labeled debater proposals", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateReReviewPrompt(PROPOSALS, CRITIQUES, DIFF, [FINDING], ctx);
    expect(prompt).toContain("claude");
    expect(prompt).toContain("opencode");
  });

  test("asks for deltaSummary in JSON", () => {
    const ctx: DebateResolverContext = { resolverType: "synthesis" };
    const prompt = buildDebateReReviewPrompt(PROPOSALS, CRITIQUES, DIFF, [FINDING], ctx);
    expect(prompt).toContain("deltaSummary");
  });
});
