/**
 * Tests for buildConstraintsSection.
 *
 * Verifies the section includes:
 * - max substories limit
 * - max complexity limit
 * - JSON output schema (with nonOverlapJustification and parentStoryId)
 */

import { describe, test, expect } from "bun:test";
import { buildConstraintsSection } from "../../../../src/decompose/sections/constraints";
import type { DecomposeConfig } from "../../../../src/decompose/types";

function makeConfig(overrides: Partial<DecomposeConfig> = {}): DecomposeConfig {
  return {
    maxSubStories: 6,
    maxComplexity: "complex",
    ...overrides,
  };
}

describe("buildConstraintsSection()", () => {
  test("includes maxSubStories value", () => {
    const section = buildConstraintsSection(makeConfig({ maxSubStories: 6 }));
    expect(section).toContain("6");
  });

  test("reflects custom maxSubStories in output", () => {
    const section = buildConstraintsSection(makeConfig({ maxSubStories: 3 }));
    expect(section).toContain("3");
  });

  test("includes max complexity value", () => {
    const section = buildConstraintsSection(makeConfig({ maxComplexity: "complex" }));
    expect(section).toContain("complex");
  });

  test("reflects custom maxComplexity in output", () => {
    const section = buildConstraintsSection(makeConfig({ maxComplexity: "simple" }));
    expect(section).toContain("simple");
  });

  test("includes JSON output schema reference", () => {
    const section = buildConstraintsSection(makeConfig());
    expect(section.toLowerCase()).toContain("json");
  });

  test("includes nonOverlapJustification as required schema field", () => {
    const section = buildConstraintsSection(makeConfig());
    expect(section).toContain("nonOverlapJustification");
  });

  test("includes parentStoryId as schema field", () => {
    const section = buildConstraintsSection(makeConfig());
    expect(section).toContain("parentStoryId");
  });

  test("different configs produce different sections", () => {
    const sec1 = buildConstraintsSection(makeConfig({ maxSubStories: 3 }));
    const sec2 = buildConstraintsSection(makeConfig({ maxSubStories: 8 }));
    expect(sec1).not.toBe(sec2);
  });

  test("works with maxComplexity = simple", () => {
    const section = buildConstraintsSection(makeConfig({ maxComplexity: "simple" }));
    expect(section).toContain("simple");
  });

  test("works with maxComplexity = expert", () => {
    const section = buildConstraintsSection(makeConfig({ maxComplexity: "expert" }));
    expect(section).toContain("expert");
  });

  test("works with maxSubStories = 1", () => {
    const section = buildConstraintsSection(makeConfig({ maxSubStories: 1 }));
    expect(section).toContain("1");
  });
});
