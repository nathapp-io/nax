/**
 * Tests for dependency validator.
 *
 * AC:
 * - Dependency validator detects circular dependencies among substories
 * - Dependency validator rejects references to non-existent story IDs
 * - ID collision validator rejects substory IDs that collide with existing PRD IDs
 */

import { describe, test, expect } from "bun:test";
import { validateDependencies } from "../../../../src/decompose/validators/dependency";
import type { SubStory } from "../../../../src/decompose/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubStory(id: string, dependencies: string[] = [], overrides: Partial<SubStory> = {}): SubStory {
  return {
    id,
    parentStoryId: "SD-001",
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: [],
    tags: [],
    dependencies,
    complexity: "simple",
    nonOverlapJustification: "No overlap",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Valid dependency graphs
// ---------------------------------------------------------------------------

describe("validateDependencies — valid graphs", () => {
  test("returns valid=true with no dependencies", () => {
    const substories = [
      makeSubStory("SD-001-1", []),
      makeSubStory("SD-001-2", []),
    ];
    const result = validateDependencies(substories, []);
    expect(result.valid).toBe(true);
  });

  test("returns no errors for a simple linear dependency chain", () => {
    const substories = [
      makeSubStory("SD-001-1", []),
      makeSubStory("SD-001-2", ["SD-001-1"]),
      makeSubStory("SD-001-3", ["SD-001-2"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.errors).toHaveLength(0);
  });

  test("returns valid=true when dependencies reference existing PRD story IDs", () => {
    const substories = [
      makeSubStory("SD-001-1", ["EX-001"]),
      makeSubStory("SD-001-2", ["EX-002"]),
    ];
    const existingIds = ["EX-001", "EX-002"];
    const result = validateDependencies(substories, existingIds);
    expect(result.valid).toBe(true);
  });

  test("returns valid=true with empty substories list", () => {
    const result = validateDependencies([], ["EX-001"]);
    expect(result.valid).toBe(true);
  });

  test("returns no errors for diamond dependency pattern without cycle", () => {
    // A → B, A → C, B → D, C → D (diamond, not a cycle)
    const substories = [
      makeSubStory("SD-001-A", []),
      makeSubStory("SD-001-B", ["SD-001-A"]),
      makeSubStory("SD-001-C", ["SD-001-A"]),
      makeSubStory("SD-001-D", ["SD-001-B", "SD-001-C"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Circular dependencies
// ---------------------------------------------------------------------------

describe("validateDependencies — circular dependencies", () => {
  test("detects direct circular dependency (A → B, B → A)", () => {
    const substories = [
      makeSubStory("SD-001-1", ["SD-001-2"]),
      makeSubStory("SD-001-2", ["SD-001-1"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("error message mentions the circular dependency", () => {
    const substories = [
      makeSubStory("SD-001-1", ["SD-001-2"]),
      makeSubStory("SD-001-2", ["SD-001-1"]),
    ];
    const result = validateDependencies(substories, []);
    const msg = result.errors.join(" ").toLowerCase();
    expect(msg).toContain("circular");
  });

  test("error message references the involved story IDs", () => {
    const substories = [
      makeSubStory("SD-001-A", ["SD-001-B"]),
      makeSubStory("SD-001-B", ["SD-001-A"]),
    ];
    const result = validateDependencies(substories, []);
    const msg = result.errors.join(" ");
    expect(msg).toContain("SD-001-A");
    expect(msg).toContain("SD-001-B");
  });

  test("detects longer cycle (A → B → C → A)", () => {
    const substories = [
      makeSubStory("SD-001-1", ["SD-001-3"]),
      makeSubStory("SD-001-2", ["SD-001-1"]),
      makeSubStory("SD-001-3", ["SD-001-2"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("detects self-referential dependency (A → A)", () => {
    const substories = [
      makeSubStory("SD-001-1", ["SD-001-1"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-existent story IDs
// ---------------------------------------------------------------------------

describe("validateDependencies — non-existent story IDs", () => {
  test("returns valid=false when a dependency ID does not exist in substories or existing PRD", () => {
    const substories = [
      makeSubStory("SD-001-1", ["GHOST-999"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.valid).toBe(false);
  });

  test("produces an error for each non-existent dependency ID", () => {
    const substories = [
      makeSubStory("SD-001-1", ["GHOST-001", "GHOST-002"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test("error message references the non-existent ID", () => {
    const substories = [
      makeSubStory("SD-001-1", ["GHOST-999"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.errors.join(" ")).toContain("GHOST-999");
  });

  test("dependency on another substory in the same set is valid", () => {
    const substories = [
      makeSubStory("SD-001-1", []),
      makeSubStory("SD-001-2", ["SD-001-1"]),
    ];
    const result = validateDependencies(substories, []);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("dependency on existing PRD story ID is valid", () => {
    const substories = [
      makeSubStory("SD-001-1", ["EXISTING-001"]),
    ];
    const result = validateDependencies(substories, ["EXISTING-001"]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ID collisions with existing PRD
// ---------------------------------------------------------------------------

describe("validateDependencies — ID collisions with existing PRD", () => {
  test("returns valid=false when substory ID collides with an existing PRD story ID", () => {
    const substories = [
      makeSubStory("EX-001", []), // ID collision with existing PRD story
    ];
    const existingIds = ["EX-001", "EX-002"];
    const result = validateDependencies(substories, existingIds);
    expect(result.valid).toBe(false);
  });

  test("produces an error for each ID collision", () => {
    const substories = [
      makeSubStory("EX-001", []),
      makeSubStory("EX-002", []),
    ];
    const existingIds = ["EX-001", "EX-002"];
    const result = validateDependencies(substories, existingIds);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test("error message references the colliding ID", () => {
    const substories = [
      makeSubStory("EX-COLLISION", []),
    ];
    const existingIds = ["EX-COLLISION"];
    const result = validateDependencies(substories, existingIds);
    expect(result.errors.join(" ")).toContain("EX-COLLISION");
  });

  test("error message indicates the nature of the collision", () => {
    const substories = [
      makeSubStory("EX-001", []),
    ];
    const existingIds = ["EX-001"];
    const result = validateDependencies(substories, existingIds);
    const msg = result.errors.join(" ").toLowerCase();
    expect(msg).toMatch(/collid|duplic|already exist/);
  });

  test("substory ID that does not collide is valid", () => {
    const substories = [
      makeSubStory("SD-001-1", []),
      makeSubStory("SD-001-2", []),
    ];
    const existingIds = ["EX-001", "EX-002"];
    const result = validateDependencies(substories, existingIds);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Combined errors
// ---------------------------------------------------------------------------

describe("validateDependencies — combined error scenarios", () => {
  test("reports both circular dependency and non-existent ID in one result", () => {
    const substories = [
      makeSubStory("SD-001-1", ["SD-001-2", "GHOST-999"]),
      makeSubStory("SD-001-2", ["SD-001-1"]), // creates cycle with SD-001-1
    ];
    const result = validateDependencies(substories, []);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  test("reports ID collision alongside other errors", () => {
    const substories = [
      makeSubStory("EX-001", ["GHOST-999"]), // collision + missing dep
    ];
    const existingIds = ["EX-001"];
    const result = validateDependencies(substories, existingIds);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});
