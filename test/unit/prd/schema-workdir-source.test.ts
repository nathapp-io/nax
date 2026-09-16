/**
 * Schema validation for UserStory.workdirSource (nax#2067).
 *
 * Separate from schema.test.ts, which is 791 lines against the 800-line cap.
 */

import { describe, expect, test } from "bun:test";
import { validateStory } from "@/prd/schema-story";

function baseStory(overrides: Record<string, unknown> = {}) {
  return {
    id: "US-001",
    title: "A story",
    description: "Does a thing",
    acceptanceCriteria: ["When x, then y"],
    complexity: "simple",
    ...overrides,
  };
}

/**
 * validateStory takes FOUR arguments: (raw, index, allIds, seenIds).
 *
 * `seenIds` is MUTATED — schema-story.ts:103 does `seenIds.add(id)` after a
 * duplicate check at :92. Sharing one Set across calls therefore makes the
 * second call with the same story id throw "duplicate id". Every call below
 * gets its own pair of Sets.
 */
function validate(raw: Record<string, unknown>) {
  return validateStory(raw, 0, new Set<string>(["US-001"]), new Set<string>());
}

describe("validateStory — workdirSource (nax#2067)", () => {
  test("passes through each of the three legal values", () => {
    for (const source of ["stated", "derived", "defaulted"] as const) {
      const story = validate(baseStory({ workdir: "packages/app", workdirSource: source }));
      expect(story.workdirSource).toBe(source);
    }
  });

  test("omits the field entirely when absent", () => {
    const story = validate(baseStory());
    expect(story.workdirSource).toBeUndefined();
    expect("workdirSource" in story).toBe(false);
  });

  test("rejects a value outside the three", () => {
    expect(() => validate(baseStory({ workdirSource: "guessed" }))).toThrow(/workdirSource/);
  });

  test("rejects a non-string value", () => {
    expect(() => validate(baseStory({ workdirSource: 3 }))).toThrow(/workdirSource/);
  });

  test("a defaulted story may carry no workdir", () => {
    const story = validate(baseStory({ workdirSource: "defaulted" }));
    expect(story.workdirSource).toBe("defaulted");
    expect(story.workdir).toBeUndefined();
  });
});
