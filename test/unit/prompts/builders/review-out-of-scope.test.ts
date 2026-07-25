/**
 * Feature-level out-of-scope rendering in the two reviewer prompts.
 *
 * Both reviewers hand-render their own story block (they do not go through
 * buildStorySection), so this is the only place the propagated
 * `story.outOfScope` list reaches them. The numbering is load-bearing —
 * `scopeIndex` on a finding is a 1-based index into it.
 */

import { describe, expect, test } from "bun:test";
import { AdversarialReviewPromptBuilder, ReviewPromptBuilder, buildReviewOutOfScopeBlock } from "@/prompts";
import type { AdversarialReviewConfig, SemanticReviewConfig, SemanticStory } from "@/review";

const OUT_OF_SCOPE = ["An interactive Ink TUI", "Per-story diffs or checkpoints"];

function makeStory(outOfScope?: string[]): SemanticStory {
  return {
    id: "US-001",
    title: "Reconstruct the run timeline",
    description: "Build the replay core.",
    acceptanceCriteria: ["When a run id is given, then a RunTimeline is returned"],
    ...(outOfScope ? { outOfScope } : {}),
  };
}

const semanticConfig = { model: "balanced", diffMode: "ref", rules: [] } as unknown as SemanticReviewConfig;
const adversarialConfig = { model: "balanced", diffMode: "ref", rules: [] } as unknown as AdversarialReviewConfig;

function semanticPrompt(story: SemanticStory): string {
  return new ReviewPromptBuilder().buildSemanticReviewPrompt(story, semanticConfig, {
    mode: "ref",
    storyGitRef: "abc123",
    stat: " src/a.ts | 2 +-",
  });
}

function adversarialPrompt(story: SemanticStory): string {
  return new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(story, adversarialConfig, {
    mode: "ref",
    storyGitRef: "abc123",
    stat: " src/a.ts | 2 +-",
  });
}

describe("buildReviewOutOfScopeBlock", () => {
  test("numbers entries 1-based so scopeIndex resolves", () => {
    const block = buildReviewOutOfScopeBlock(OUT_OF_SCOPE);
    expect(block).toContain("1. An interactive Ink TUI");
    expect(block).toContain("2. Per-story diffs or checkpoints");
    expect(block).not.toContain("0. ");
  });

  test("states that entries are not acceptance criteria", () => {
    const block = buildReviewOutOfScopeBlock(OUT_OF_SCOPE);
    expect(block).toContain("NOT acceptance criteria");
    expect(block).toContain("scopeQuote");
    expect(block).toContain("scopeIndex");
  });

  test("renders nothing when there are no exclusions", () => {
    expect(buildReviewOutOfScopeBlock([])).toBe("");
    expect(buildReviewOutOfScopeBlock(undefined)).toBe("");
  });
});

describe("semantic review prompt", () => {
  test("includes the numbered out-of-scope list", () => {
    const prompt = semanticPrompt(makeStory(OUT_OF_SCOPE));
    expect(prompt).toContain("Out of Scope (feature-level — NOT acceptance criteria)");
    expect(prompt).toContain("1. An interactive Ink TUI");
  });

  test("keeps exclusions out of the acceptance-criteria list", () => {
    const prompt = semanticPrompt(makeStory(OUT_OF_SCOPE));
    const acIndex = prompt.indexOf("### Acceptance Criteria");
    const oosIndex = prompt.indexOf("Out of Scope (feature-level");
    expect(acIndex).toBeGreaterThan(-1);
    expect(oosIndex).toBeGreaterThan(acIndex);
  });

  test("omits the block when the story declares no exclusions", () => {
    expect(semanticPrompt(makeStory())).not.toContain("Out of Scope (feature-level");
  });
});

describe("adversarial review prompt", () => {
  test("includes the numbered out-of-scope list", () => {
    const prompt = adversarialPrompt(makeStory(OUT_OF_SCOPE));
    expect(prompt).toContain("Out of Scope (feature-level — NOT acceptance criteria)");
    expect(prompt).toContain("2. Per-story diffs or checkpoints");
  });

  test("instructs scope findings to cite scopeQuote and stay at warning severity", () => {
    const prompt = adversarialPrompt(makeStory(OUT_OF_SCOPE));
    expect(prompt).toContain('"out-of-scope"');
    expect(prompt).toContain("scopeQuote");
    expect(prompt).toContain('Emit scope-violation findings as `"warning"` — never `"error"`');
  });

  test("advertises scopeQuote / scopeIndex in the output schema", () => {
    const prompt = adversarialPrompt(makeStory(OUT_OF_SCOPE));
    expect(prompt).toContain('"scopeQuote"');
    expect(prompt).toContain('"scopeIndex"');
  });

  test("omits the block when the story declares no exclusions", () => {
    expect(adversarialPrompt(makeStory())).not.toContain("Out of Scope (feature-level");
  });
});
