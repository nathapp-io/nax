/** Renderer for the imperative `story.outOfScope` block shared by story sections. */

import { describe, expect, test } from "bun:test";
import { buildOutOfScopeLines } from "@/prompts";

const OUT_OF_SCOPE = ["An interactive Ink TUI", "Per-story diffs or checkpoints"];

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
