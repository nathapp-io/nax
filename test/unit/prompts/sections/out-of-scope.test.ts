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
