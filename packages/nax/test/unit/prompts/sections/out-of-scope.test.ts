/**
 * Renderer for `story.outOfScope` — shared by the story sections (imperative
 * "do NOT implement" block) and both reviewer prompts (numbered list, because a
 * scope finding cites `scopeIndex` into it).
 */

import { describe, expect, test } from "bun:test";
import { buildOutOfScopeLines, buildReviewOutOfScopeBlock } from "@/prompts";

const OUT_OF_SCOPE = ["An interactive Ink TUI", "Per-story diffs or checkpoints"];

describe("buildReviewOutOfScopeBlock", () => {
  test("numbers entries 1-based so scopeIndex resolves", () => {
    const block = buildReviewOutOfScopeBlock(OUT_OF_SCOPE);
    expect(block).toContain("1. An interactive Ink TUI");
    expect(block).toContain("2. Per-story diffs or checkpoints");
    expect(block).not.toContain("0. ");
  });

  test("states that entries are not acceptance criteria in both modes", () => {
    for (const block of [
      buildReviewOutOfScopeBlock(OUT_OF_SCOPE),
      buildReviewOutOfScopeBlock(OUT_OF_SCOPE, { citable: true }),
    ]) {
      expect(block).toContain("NOT acceptance criteria");
      expect(block).toContain("never cite one as `acQuote`/`acIndex`");
    }
  });

  test("only the citable variant asks for a scopeQuote citation", () => {
    // The semantic path has no scopeQuote/scopeIndex schema fields and no
    // filterByScopeQuote — a finding it cannot express is dropped by its own
    // AC-grounding filter, failing the story with an empty findings list.
    const semantic = buildReviewOutOfScopeBlock(OUT_OF_SCOPE);
    expect(semantic).not.toContain("scopeQuote");
    expect(semantic).not.toContain("scopeIndex");
    expect(semantic).toContain("Report nothing against this list");

    const adversarial = buildReviewOutOfScopeBlock(OUT_OF_SCOPE, { citable: true });
    expect(adversarial).toContain("scopeQuote");
    expect(adversarial).toContain("scopeIndex");
  });

  test("the citable variant caps scope findings at warning severity", () => {
    expect(buildReviewOutOfScopeBlock(OUT_OF_SCOPE, { citable: true })).toContain('never `"error"`');
  });

  test("renders nothing when there are no exclusions", () => {
    expect(buildReviewOutOfScopeBlock([])).toBe("");
    expect(buildReviewOutOfScopeBlock(undefined)).toBe("");
    expect(buildReviewOutOfScopeBlock([], { citable: true })).toBe("");
  });
});

describe("buildOutOfScopeLines", () => {
  test("renders an imperative block for builder roles", () => {
    const lines = buildOutOfScopeLines(OUT_OF_SCOPE);
    expect(lines).toContain("**Out of Scope — do NOT implement these:**");
    expect(lines).toContain("- An interactive Ink TUI");
  });

  test("returns an empty array when there are no exclusions, so callers can spread it", () => {
    expect(buildOutOfScopeLines([])).toEqual([]);
    expect(buildOutOfScopeLines(undefined)).toEqual([]);
  });
});
