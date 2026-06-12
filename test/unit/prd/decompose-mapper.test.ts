/**
 * Unit tests for mapDecomposedStoriesToUserStories (US-003)
 *
 * Covers:
 * - AC1: routing.complexity and routing.testStrategy mapped from DecomposedStory
 * - AC2: lifecycle defaults (status, passes, escalations, attempts)
 * - AC3: NaxError DECOMPOSE_VALIDATION_FAILED with entry index for missing id
 * - AC4: empty contextFiles warns and continues (does not throw)
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
  test.each([
    ["complexity", { complexity: "complex" as const }, "complexity" as const, "complex"],
    ["testStrategy", { testStrategy: "tdd-simple" as const }, "testStrategy" as const, "tdd-simple"],
    ["reasoning", { reasoning: "Clear isolated task" }, "reasoning" as const, "Clear isolated task"],
    ["testStrategy fallback", { testStrategy: undefined }, "testStrategy" as const, "test-after"],
  ])("maps %s correctly", (_label, override, field, expected) => {
    const story = makeDecomposedStory(override);
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.[field]).toBe(expected);
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
  test.each([
    ["status", "status" as const, "pending" as const],
    ["passes", "passes" as const, false as const],
    ["attempts", "attempts" as const, 0 as const],
  ])("sets %s to default", (_label, field, expected) => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001");
    expect(result[field]).toBe(expected);
  });

  test("sets escalations to empty array", () => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001");
    expect(result.escalations).toEqual([]);
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

  test.each([
    ["not provided", undefined as string | undefined],
    ["explicitly undefined", undefined],
  ])("workdir is absent when parentWorkdir is %s", (_label, parentWorkdir) => {
    const [result] = mapDecomposedStoriesToUserStories([makeDecomposedStory()], "US-001", parentWorkdir);
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
// Agent routing propagation — routing.agent, agentProfileId, profileModelTier
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — agent routing propagation", () => {
  test("propagates routing.agent when set on DecomposedStory", () => {
    const story = makeDecomposedStory({ routing: { agent: "opencode", agentProfileId: "fast-coder", profileModelTier: "fast" } });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.agent).toBe("opencode");
  });

  test("propagates routing.agentProfileId when set on DecomposedStory", () => {
    const story = makeDecomposedStory({ routing: { agent: "opencode", agentProfileId: "fast-coder", profileModelTier: "fast" } });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.agentProfileId).toBe("fast-coder");
  });

  test("propagates routing.profileModelTier when set on DecomposedStory", () => {
    const story = makeDecomposedStory({ routing: { agent: "opencode", agentProfileId: "fast-coder", profileModelTier: "fast" } });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.profileModelTier).toBe("fast");
  });

  test("profileModelTier is absent when routing is not set on DecomposedStory", () => {
    const story = makeDecomposedStory({ routing: undefined });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.profileModelTier).toBeUndefined();
  });

  test("propagates 'balanced' profileModelTier correctly", () => {
    const story = makeDecomposedStory({ routing: { agent: "claude", agentProfileId: "quality-agent", profileModelTier: "balanced" } });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.profileModelTier).toBe("balanced");
  });

  test("propagates 'powerful' profileModelTier correctly", () => {
    const story = makeDecomposedStory({ routing: { agent: "claude", agentProfileId: "expert-agent", profileModelTier: "powerful" } });
    const [result] = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result.routing?.profileModelTier).toBe("powerful");
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

  test.each<[string, DecomposedStory[], number]>([
    ["first", [makeDecomposedStory({ id: "" })], 0],
    ["second", [makeDecomposedStory({ id: "US-001-A" }), makeDecomposedStory({ id: "" })], 1],
    ["third", [makeDecomposedStory({ id: "US-001-A" }), makeDecomposedStory({ id: "US-001-B" }), makeDecomposedStory({ id: "" })], 2],
  ])("includes entry index in error context for %s entry with missing id", (_pos, stories, expectedIndex) => {
    let caught: NaxError | undefined;
    try {
      mapDecomposedStoriesToUserStories(stories, "US-001");
    } catch (err) {
      caught = err as NaxError;
    }
    expect(caught?.context?.entryIndex).toBe(expectedIndex);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// modelTier seeding from profileModelTier
// ─────────────────────────────────────────────────────────────────────────────

describe("modelTier seeding from profileModelTier", () => {
  const baseStory = {
    id: "US-001-A",
    title: "Sub-story",
    description: "Desc",
    acceptanceCriteria: ["AC1"],
    tags: [],
    dependencies: [],
    contextFiles: ["src/a.ts"],
    complexity: "medium" as const,
    testStrategy: "test-after" as const,
    reasoning: "r",
  };

  test("seeds modelTier from profileModelTier when a profile was resolved", () => {
    const result = mapDecomposedStoriesToUserStories(
      [
        {
          ...baseStory,
          routing: { agent: "opencode", agentProfileId: "oc-fast", profileModelTier: "fast" as const },
        },
      ],
      "US-001",
    );
    expect(result[0].routing?.modelTier).toBe("fast");
  });

  test("defaults modelTier to balanced when no profileModelTier", () => {
    const result = mapDecomposedStoriesToUserStories([{ ...baseStory }], "US-001");
    expect(result[0].routing?.modelTier).toBe("balanced");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: validation — empty contextFiles (warn, not throw)
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — validation: empty contextFiles", () => {
  test("does not throw when contextFiles is empty — warns and continues", () => {
    const story = makeDecomposedStory({ contextFiles: [] });
    expect(() => mapDecomposedStoriesToUserStories([story], "US-001")).not.toThrow();
  });

  test("returns story with empty contextFiles when LLM omitted them", () => {
    const story = makeDecomposedStory({ contextFiles: [] });
    const result = mapDecomposedStoriesToUserStories([story], "US-001");
    expect(result).toHaveLength(1);
    expect(result[0]?.contextFiles).toEqual([]);
  });

  test("processes all stories even when some have empty contextFiles", () => {
    const stories = [
      makeDecomposedStory({ id: "US-001-A", contextFiles: ["src/a.ts"] }),
      makeDecomposedStory({ id: "US-001-B", contextFiles: [] }),
      makeDecomposedStory({ id: "US-001-C", contextFiles: ["src/c.ts"] }),
    ];
    const result = mapDecomposedStoriesToUserStories(stories, "US-001");
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.id)).toEqual(["US-001-A", "US-001-B", "US-001-C"]);
  });
});
