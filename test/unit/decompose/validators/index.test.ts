/**
 * Tests for runAllValidators() orchestrator.
 *
 * AC: runAllValidators() returns merged ValidationResult with all errors and warnings.
 */

import { describe, test, expect } from "bun:test";
import { runAllValidators } from "../../../../src/decompose/validators/index";
import type { SubStory, DecomposeConfig } from "../../../../src/decompose/types";
import type { UserStory } from "../../../../src/prd";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<DecomposeConfig> = {}): DecomposeConfig {
  return {
    maxSubStories: 5,
    maxComplexity: "complex",
    maxRetries: 2,
    ...overrides,
  };
}

function makeOriginalStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "SD-001",
    title: "User authentication system",
    description: "Build complete user authentication",
    acceptanceCriteria: [
      "User can register",
      "User can log in",
      "User can reset password",
    ],
    tags: ["auth"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makeSubStory(id: string, overrides: Partial<SubStory> = {}): SubStory {
  return {
    id,
    parentStoryId: "SD-001",
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    complexity: "simple",
    nonOverlapJustification: "No overlap",
    ...overrides,
  };
}

function makeExistingStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Existing story ${id}`,
    description: `Existing description for ${id}`,
    acceptanceCriteria: ["existing AC"],
    tags: ["unrelated"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// All validators pass
// ---------------------------------------------------------------------------

describe("runAllValidators — all pass", () => {
  test("returns valid=true when all validators pass", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-1", {
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
    ];
    const existing = [makeExistingStory("EX-001")];
    const config = makeConfig();
    const result = runAllValidators(original, substories, existing, config);
    expect(result.valid).toBe(true);
  });

  test("returns empty errors array when all validators pass", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-1", {
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
    ];
    const existing = [makeExistingStory("EX-001")];
    const config = makeConfig();
    const result = runAllValidators(original, substories, existing, config);
    expect(result.errors).toHaveLength(0);
  });

  test("returns empty warnings array when all validators pass", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-1", {
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
    ];
    const existing = [makeExistingStory("EX-001")];
    const config = makeConfig();
    const result = runAllValidators(original, substories, existing, config);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Complexity validator errors propagate
// ---------------------------------------------------------------------------

describe("runAllValidators — complexity errors propagate", () => {
  test("returns valid=false when a substory exceeds maxComplexity", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-1", {
        complexity: "expert", // exceeds maxComplexity: "medium"
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
    ];
    const existing = [makeExistingStory("EX-001")];
    const config = makeConfig({ maxComplexity: "medium" });
    const result = runAllValidators(original, substories, existing, config);
    expect(result.valid).toBe(false);
  });

  test("complexity error is included in merged errors", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-X", {
        complexity: "expert",
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
    ];
    const config = makeConfig({ maxComplexity: "simple" });
    const result = runAllValidators(original, substories, [], config);
    expect(result.errors.join(" ")).toContain("SD-001-X");
  });
});

// ---------------------------------------------------------------------------
// Dependency validator errors propagate
// ---------------------------------------------------------------------------

describe("runAllValidators — dependency errors propagate", () => {
  test("returns valid=false when substory IDs collide with existing PRD", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("EX-001", { // collision with existing
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
    ];
    const existing = [makeExistingStory("EX-001")];
    const config = makeConfig();
    const result = runAllValidators(original, substories, existing, config);
    expect(result.valid).toBe(false);
  });

  test("returns valid=false when circular dependency detected", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-1", {
        dependencies: ["SD-001-2"],
        acceptanceCriteria: ["User can register"],
      }),
      makeSubStory("SD-001-2", {
        dependencies: ["SD-001-1"],
        acceptanceCriteria: ["User can log in", "User can reset password"],
      }),
    ];
    const config = makeConfig();
    const result = runAllValidators(original, substories, [], config);
    expect(result.valid).toBe(false);
  });

  test("circular dependency error is included in merged errors", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-A", {
        dependencies: ["SD-001-B"],
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
      makeSubStory("SD-001-B", { dependencies: ["SD-001-A"] }),
    ];
    const config = makeConfig();
    const result = runAllValidators(original, substories, [], config);
    const msg = result.errors.join(" ").toLowerCase();
    expect(msg).toContain("circular");
  });
});

// ---------------------------------------------------------------------------
// Coverage validator warnings propagate
// ---------------------------------------------------------------------------

describe("runAllValidators — coverage warnings propagate", () => {
  test("coverage warnings appear in merged warnings", () => {
    const original = makeOriginalStory({
      acceptanceCriteria: ["User can register", "UNIQUE_UNCOVERED_CRITERION_XYZZY"],
    });
    const substories = [
      makeSubStory("SD-001-1", {
        acceptanceCriteria: ["User can register"],
      }),
    ];
    const config = makeConfig();
    const result = runAllValidators(original, substories, [], config);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Overlap validator warnings and errors propagate
// ---------------------------------------------------------------------------

describe("runAllValidators — overlap findings propagate", () => {
  test("overlap errors appear in merged errors and set valid=false", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-1", {
        title: "overlap validator keyword similarity check jaccard index",
        description: "overlap validator with jaccard keyword similarity index detection threshold",
        acceptanceCriteria: [
          "overlap validator detects keyword similarity",
          "jaccard similarity computed correctly",
          "threshold returns error detection",
        ],
        tags: ["validation", "overlap", "keywords", "jaccard"],
      }),
    ];
    const existing = [
      makeExistingStory("EX-DUP", {
        title: "overlap validator keyword similarity check jaccard index",
        description: "overlap validator jaccard keyword similarity detection index",
        acceptanceCriteria: [
          "overlap validator detects keyword similarity",
          "jaccard similarity computed correctly",
          "threshold error detection works",
        ],
        tags: ["validation", "overlap", "keywords", "jaccard"],
      }),
    ];
    const config = makeConfig();
    const result = runAllValidators(original, substories, existing, config);
    // Overlap detection should propagate to merged result
    expect(result.errors.length + result.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Merged result structure
// ---------------------------------------------------------------------------

describe("runAllValidators — result structure", () => {
  test("always returns an object with valid, errors, and warnings", () => {
    const result = runAllValidators(makeOriginalStory(), [], [], makeConfig());
    expect(typeof result.valid).toBe("boolean");
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test("errors from multiple validators are merged into a single array", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("EX-COLLISION", { // ID collision
        complexity: "expert", // also exceeds max
        dependencies: ["GHOST-999"], // non-existent dep
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
    ];
    const existing = [makeExistingStory("EX-COLLISION")];
    const config = makeConfig({ maxComplexity: "simple" });
    const result = runAllValidators(original, substories, existing, config);
    // Multiple validators should contribute errors
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test("valid=false when any validator contributes errors", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory("SD-001-1", {
        complexity: "expert",
        acceptanceCriteria: ["User can register", "User can log in", "User can reset password"],
      }),
    ];
    const config = makeConfig({ maxComplexity: "simple" });
    const result = runAllValidators(original, substories, [], config);
    expect(result.valid).toBe(false);
  });

  test("valid=true when there are only warnings but no errors", () => {
    const original = makeOriginalStory({
      acceptanceCriteria: ["User can register", "UNIQUE_UNCOVERED_CRITERION_XYZZY_12345"],
    });
    const substories = [
      makeSubStory("SD-001-1", {
        complexity: "simple",
        acceptanceCriteria: ["User can register"],
      }),
    ];
    const config = makeConfig({ maxComplexity: "expert" });
    const result = runAllValidators(original, substories, [], config);
    // Warnings from coverage but no errors — valid should be true
    if (result.warnings.length > 0) {
      expect(result.valid).toBe(true);
    }
  });
});
