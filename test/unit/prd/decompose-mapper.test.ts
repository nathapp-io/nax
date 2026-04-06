/**
 * Unit tests for mapDecomposedStoriesToUserStories (US-003)
 *
 * Covers:
 * - AC1: routing.complexity and routing.testStrategy mapped from DecomposedStory
 * - AC2: lifecycle defaults (status, passes, escalations, attempts)
 * - AC3: NaxError DECOMPOSE_VALIDATION_FAILED with entry index for missing id
 * - AC4: NaxError DECOMPOSE_VALIDATION_FAILED with entry index for empty contextFiles
 */

import { describe, expect, test } from "bun:test";
import type { DecomposedStory } from "../../../src/agents/shared/types-extended";
import { NaxError } from "../../../src/errors";
import { mapDecomposedStoriesToUserStories } from "../../../src/prd/decompose-mapper";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeDecomposedStory(overrides: Partial<DecomposedStory> = {}): DecomposedStory {
  return {
    id: "US-001-A",
    title: "Implement sub-story A",
    description: "Description of sub-story A",
    acceptanceCriteria: ["AC-1: Does the thing"],
    tags: ["feature"],
    dependencies: [],
    complexity: "simple",
    contextFiles: ["src/feature.ts"],
    reasoning: "Simple single-function task",
    estimatedLOC: 50,
    risks: [],
    testStrategy: "test-after",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: routing field mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — routing field mapping", () => {
  test("maps complexity to routing.complexity", () => {
    const story = makeDecomposedStory({ complexity: "complex" });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.complexity).toBe("complex");
  });

  test("maps testStrategy to routing.testStrategy", () => {
    const story = makeDecomposedStory({ testStrategy: "tdd-simple" });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.testStrategy).toBe("tdd-simple");
  });

  test("maps reasoning to routing.reasoning", () => {
    const story = makeDecomposedStory({ reasoning: "Clear isolated task" });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.reasoning).toBe("Clear isolated task");
  });

  test("uses test-after fallback when testStrategy is undefined", () => {
    const story = makeDecomposedStory({ testStrategy: undefined });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.testStrategy).toBe("test-after");
  });

  test("maps all complexity values correctly", () => {
    const complexities = ["simple", "medium", "complex", "expert"] as const;
    for (const complexity of complexities) {
      const story = makeDecomposedStory({ id: `US-001-${complexity}`, complexity });
      const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
      expect(result.routing?.complexity).toBe(complexity);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: lifecycle defaults
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — lifecycle defaults", () => {
  test("sets status to pending", () => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001");
    expect(result.status).toBe("pending");
  });

  test("sets passes to false", () => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001");
    expect(result.passes).toBe(false);
  });

  test("sets escalations to empty array", () => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001");
    expect(result.escalations).toEqual([]);
  });

  test("sets attempts to 0", () => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001");
    expect(result.attempts).toBe(0);
  });

  test("sets parentStoryId from argument", () => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-042");
    expect(result.parentStoryId).toBe("US-042");
  });

  test("all mapped stories share same lifecycle defaults", () => {
    const stories = [
      makeDecomposedStory({ id: "US-001-A" }),
      makeDecomposedStory({ id: "US-001-B" }),
      makeDecomposedStory({ id: "US-001-C" }),
    ];
    const results = mapDecomposedStoriesToUserStories(stories, "US-001");
    for (const r of results) {
      expect(r.status).toBe("pending");
      expect(r.passes).toBe(false);
      expect(r.escalations).toEqual([]);
      expect(r.attempts).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Direct field passthrough
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — direct field mapping", () => {
  test("passes through id, title, description, acceptanceCriteria, tags, dependencies, contextFiles", () => {
    const story = makeDecomposedStory({
      id: "US-002-B",
      title: "My title",
      description: "My desc",
      acceptanceCriteria: ["AC-1", "AC-2"],
      tags: ["security"],
      dependencies: ["US-001"],
      contextFiles: ["src/a.ts", "src/b.ts"],
    });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-002");
    expect(result.id).toBe("US-002-B");
    expect(result.title).toBe("My title");
    expect(result.description).toBe("My desc");
    expect(result.acceptanceCriteria).toEqual(["AC-1", "AC-2"]);
    expect(result.tags).toEqual(["security"]);
    expect(result.dependencies).toEqual(["US-001"]);
    expect(result.contextFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("returns array with same length as input", () => {
    const stories = [
      makeDecomposedStory({ id: "US-001-A" }),
      makeDecomposedStory({ id: "US-001-B", complexity: "medium" }),
      makeDecomposedStory({ id: "US-001-C", complexity: "expert" }),
    ];
    const result = mapDecomposedStoriesToUserStories(stories, "US-001");
    expect(result).toHaveLength(3);
  });

  test("returns empty array for empty input", () => {
    const result = mapDecomposedStoriesToUserStories([], "US-001");
    expect(result).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// workdir inheritance — sub-stories must inherit parent workdir (PKG-003)
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — workdir inheritance", () => {
  test("sub-stories inherit parentWorkdir when provided", () => {
    const stories = [
      makeDecomposedStory({ id: "US-002-A" }),
      makeDecomposedStory({ id: "US-002-B" }),
    ];
    const result = mapDecomposedStoriesToUserStories(stories, "US-002", "apps/api");
    expect(result[0].workdir).toBe("apps/api");
    expect(result[1].workdir).toBe("apps/api");
  });

  test("workdir is absent when parentWorkdir is not provided", () => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001");
    expect(result.workdir).toBeUndefined();
  });

  test("workdir is absent when parentWorkdir is undefined", () => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001", undefined);
    expect(result.workdir).toBeUndefined();
  });

  test("all sub-stories get the same workdir as the parent", () => {
    const stories = [
      makeDecomposedStory({ id: "VCS-P1-002-A" }),
      makeDecomposedStory({ id: "VCS-P1-002-B" }),
      makeDecomposedStory({ id: "VCS-P1-002-C" }),
    ];
    const result = mapDecomposedStoriesToUserStories(stories, "VCS-P1-002", "apps/api");
    for (const story of result) {
      expect(story.workdir).toBe("apps/api");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: validation — missing id
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — validation: missing id", () => {
  test("throws NaxError when first entry has empty id", () => {
    const story = makeDecomposedStory({ id: "" });
    expect(() => mapDecomposedStoriesToUserStories([story], "US-001")).toThrow(NaxError);
  });

  test("throws with code DECOMPOSE_VALIDATION_FAILED when id is empty string", () => {
    const story = makeDecomposedStory({ id: "" });
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories([story], "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.code).toBe("DECOMPOSE_VALIDATION_FAILED");
  });

  test("includes entry index 0 in error context for first entry with missing id", () => {
    const story = makeDecomposedStory({ id: "" });
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories([story], "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.context?.entryIndex).toBe(0);
  });

  test("includes entry index 1 in error context when second entry has missing id", () => {
    const valid = makeDecomposedStory({ id: "US-001-A" });
    const invalid = makeDecomposedStory({ id: "" });
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories([valid, invalid], "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.context?.entryIndex).toBe(1);
  });

  test("includes entry index 2 in error context when third entry has missing id", () => {
    const a = makeDecomposedStory({ id: "US-001-A" });
    const b = makeDecomposedStory({ id: "US-001-B" });
    const c = makeDecomposedStory({ id: "" });
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories([a, b, c], "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.context?.entryIndex).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: validation — empty contextFiles
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — validation: empty contextFiles", () => {
  test("throws NaxError when contextFiles is empty array", () => {
    const story = makeDecomposedStory({ contextFiles: [] });
    expect(() => mapDecomposedStoriesToUserStories([story], "US-001")).toThrow(NaxError);
  });

  test("throws with code DECOMPOSE_VALIDATION_FAILED when contextFiles is empty", () => {
    const story = makeDecomposedStory({ contextFiles: [] });
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories([story], "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.code).toBe("DECOMPOSE_VALIDATION_FAILED");
  });

  test("includes entry index 0 in error context for first entry with empty contextFiles", () => {
    const story = makeDecomposedStory({ contextFiles: [] });
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories([story], "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.context?.entryIndex).toBe(0);
  });

  test("includes entry index 2 in error context when third entry has empty contextFiles", () => {
    const a = makeDecomposedStory({ id: "US-001-A", contextFiles: ["src/a.ts"] });
    const b = makeDecomposedStory({ id: "US-001-B", contextFiles: ["src/b.ts"] });
    const c = makeDecomposedStory({ id: "US-001-C", contextFiles: [] });
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories([a, b, c], "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.context?.entryIndex).toBe(2);
  });

  test("includes entry index 1 when second entry has empty contextFiles", () => {
    const valid = makeDecomposedStory({ id: "US-001-A", contextFiles: ["src/x.ts"] });
    const invalid = makeDecomposedStory({ id: "US-001-B", contextFiles: [] });
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories([valid, invalid], "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.context?.entryIndex).toBe(1);
  });
});
