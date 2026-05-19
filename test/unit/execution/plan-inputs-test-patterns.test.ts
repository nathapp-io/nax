/**
 * PlanInputs — resolved test patterns validation (AC3 coverage)
 *
 * Covers AC3: missing resolved test patterns produces a deterministic structured failure
 * (no implicit non-null assertion behavior).
 *
 * Callers pass `null` when patterns were required but could not be resolved; the boundary
 * fails here deterministically instead of propagating null into test-slot inputs.
 * Pass `undefined` (or omit) when test patterns are not needed for the plan.
 *
 * Kept separate from plan-inputs.test.ts (concern-based split per test-architecture.md).
 */

import { describe, test, expect } from "bun:test";
import { NaxError } from "@/errors";
import { assemblePlanInputs } from "@/execution";
import { makeNaxConfig, makeStory } from "@test/helpers";

describe("assemblePlanInputs — test patterns validation (AC3)", () => {
  test("succeeds when resolvedTestPatterns is undefined (not needed)", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config, undefined);
    expect(result).toBeDefined();
    expect(result.resolvedTestPatterns).toBeUndefined();
  });

  test("succeeds when resolvedTestPatterns is omitted", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    const result = assemblePlanInputs(story, config);
    expect(result).toBeDefined();
    expect(result.resolvedTestPatterns).toBeUndefined();
  });

  test("throws NaxError when resolvedTestPatterns is explicitly null", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    expect(() => {
      assemblePlanInputs(story, config, null);
    }).toThrow(NaxError);
  });

  test("error code is TEST_PATTERNS_MISSING for null patterns", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).code).toBe("TEST_PATTERNS_MISSING");
    }
  });

  test("error context.stage is 'execution-inputs' for null patterns", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.stage).toBe("execution-inputs");
    }
  });

  test("error context includes storyId for correlation", () => {
    const story = makeStory({ id: "US-042", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.storyId).toBe("US-042");
    }
  });

  test("error context.field is 'resolvedTestPatterns' for null patterns", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect((err as NaxError).context?.field).toBe("resolvedTestPatterns");
    }
  });

  test("error message is human-readable and references test patterns", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      const msg = (err as NaxError).message.toLowerCase();
      expect(msg).toContain("test");
      expect(msg.length).toBeGreaterThan(0);
    }
  });

  test("error code is UPPER_SNAKE_CASE (machine-parseable)", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(/^[A-Z_]+$/.test((err as NaxError).code)).toBe(true);
    }
  });

  test("story.id check fires before test-patterns check (story guard takes priority)", () => {
    const story = makeStory({ id: "" }); // Invalid story
    const config = makeNaxConfig();

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      // Story validation fires first
      expect((err as NaxError).code).toBe("STORY_ID_INVALID");
    }
  });

  test("config guard fires before test-patterns check", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig({
      agent: { default: "", fallback: { map: {} } },
    });

    try {
      assemblePlanInputs(story, config, null);
      expect.unreachable("Should have thrown");
    } catch (err) {
      // Config validation fires before test patterns
      expect((err as NaxError).code).toBe("CONFIG_INVALID");
    }
  });

  test("includes resolvedTestPatterns in returned PlanInputs when provided", () => {
    const story = makeStory({ id: "US-001", title: "Feature" });
    const config = makeNaxConfig();
    const fakePatterns = {
      globs: ["**/*.test.ts"],
      pathspec: [":!*.test.ts"],
      regex: [/\.test\.ts$/],
      testDirs: ["test"],
      resolution: "fallback" as const,
    };

    const result = assemblePlanInputs(story, config, fakePatterns);
    expect(result.resolvedTestPatterns).toBe(fakePatterns);
  });
});
