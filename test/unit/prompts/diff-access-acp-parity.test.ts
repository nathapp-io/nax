/**
 * The region must leave the ACP shell body intact: no marker survives rendering,
 * the JSON join stays at exactly two newlines, and the region adds no trailing
 * blank lines of its own. These are the invariants the suite pins.
 *
 * The byte-freeze premise this file originally carried is retired. It held the
 * ACP arm still as a control while native changed, but the delivered ACP prompt
 * moved in #2095 — buildAgentScopeSection is prepended to both arms at
 * src/agents/tool-preamble.ts:33-37 — and this file stayed green, because it
 * asserts on builder output, not the prompt the agent receives. A control arm
 * that moves while this file notices nothing is not a control arm.
 *
 * The renderer-level suite cannot check this. It exercises `applyDiffAccess` on
 * a synthetic body, and the defect this file exists for lived in the seam
 * between a real builder and `wrapJsonPrompt`: the latter runs `prompt.trim()`
 * on the composed core, the closing marker is non-whitespace, so the trim
 * stopped at the marker instead of collapsing the body's trailing newlines and
 * the semantic prompt gained a blank line.
 */
import { describe, expect, test } from "bun:test";
import { AdversarialReviewPromptBuilder } from "@/prompts/builders/adversarial-review-builder";
import { ReviewPromptBuilder } from "@/prompts/builders/review-builder";
import { applyDiffAccess, DIFF_ACCESS_MARKER_PREFIX } from "@/prompts/sections/diff-access";
import type { AdversarialReviewConfig, SemanticReviewConfig, SemanticStory } from "@/review/types";

const STORY: SemanticStory = {
  id: "US-001",
  title: "Add user auth",
  description: "Implements authentication",
  acceptanceCriteria: ["Users can log in", "Sessions expire after 24h"],
};
const STAT = "src/auth/login.ts | 10 ++++++++++\n 1 file changed";
const REF = "abc1234def";
const SEMANTIC_CONFIG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "ref",
  rules: [],
  timeoutMs: 1000,
  excludePatterns: [":!*.test.ts"],
  resetRefOnRerun: false,
};

const ADVERSARIAL_CONFIG: AdversarialReviewConfig = {
  ...SEMANTIC_CONFIG,
  parallel: false,
  maxConcurrentSessions: 2,
};

function semanticAcp(): string {
  const prompt = new ReviewPromptBuilder().buildSemanticReviewPrompt(STORY, SEMANTIC_CONFIG, {
    mode: "ref",
    storyGitRef: REF,
    stat: STAT,
    excludePatterns: [":!*.test.ts"],
  });
  return applyDiffAccess(prompt, "acp");
}

function adversarialAcp(): string {
  const prompt = new AdversarialReviewPromptBuilder().buildAdversarialReviewPrompt(STORY, ADVERSARIAL_CONFIG, {
    mode: "ref",
    storyGitRef: REF,
    stat: STAT,
  });
  return applyDiffAccess(prompt, "acp");
}

describe("ACP parity — the region leaves the pre-change prompt unchanged", () => {
  test.each([
    ["semantic", semanticAcp],
    ["adversarial", adversarialAcp],
  ])("%s: no marker survives the ACP rendering", (_label, render) => {
    expect(render()).not.toContain(DIFF_ACCESS_MARKER_PREFIX);
  });

  test.each([
    ["semantic", semanticAcp],
    ["adversarial", adversarialAcp],
  ])("%s: the shell commands are repo-rooted and scoped (no --relative)", (_label, render) => {
    const prompt = render();
    expect(prompt).toContain(`git diff --unified=3 ${REF}..HEAD -- .`);
    expect(prompt).not.toContain("--relative");
    expect(prompt).toContain(`git log --oneline ${REF}..HEAD`);
  });

  /**
   * Anchored on "AC." so it fails on the blank line the region originally added.
   * A plain `toContain("\n\nYOUR RESPONSE")` would NOT fail: "\n\n\nYOUR" contains
   * "\n\nYOUR" as a substring, and the bug would sail through.
   */
  test("semantic: the diff section still joins the JSON framing with exactly two newlines", () => {
    expect(semanticAcp()).toMatch(/verify each AC\.\n\nYOUR RESPONSE MUST START WITH/);
  });

  test("adversarial: the region does not add trailing blank lines of its own", () => {
    expect(adversarialAcp()).not.toMatch(/\n{3,}$/);
  });
});
