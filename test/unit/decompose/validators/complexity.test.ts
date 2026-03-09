/**
 * Tests for complexity validator.
 *
 * AC: Complexity validator rejects substories exceeding maxSubstoryComplexity.
 *     Reuses classifyComplexity() from src/routing/router.ts as cross-check.
 */

import { describe, test, expect } from "bun:test";
import { validateComplexity } from "../../../../src/decompose/validators/complexity";
import type { SubStory } from "../../../../src/decompose/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubStory(overrides: Partial<SubStory> = {}): SubStory {
  return {
    id: "SD-001-1",
    parentStoryId: "SD-001",
    title: "Simple task",
    description: "A simple task",
    acceptanceCriteria: ["Task completes"],
    tags: [],
    dependencies: [],
    complexity: "simple",
    nonOverlapJustification: "No overlap",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Within limit — all substories acceptable
// ---------------------------------------------------------------------------

describe("validateComplexity — within limit", () => {
  test("returns valid=true when all substories are within maxComplexity", () => {
    const substories = [
      makeSubStory({ id: "SD-001-1", complexity: "simple" }),
      makeSubStory({ id: "SD-001-2", complexity: "medium" }),
    ];
    const result = validateComplexity(substories, "medium");
    expect(result.valid).toBe(true);
  });

  test("returns no errors when all substories are within maxComplexity", () => {
    const substories = [
      makeSubStory({ id: "SD-001-1", complexity: "simple" }),
    ];
    const result = validateComplexity(substories, "expert");
    expect(result.errors).toHaveLength(0);
  });

  test("simple substory is valid when maxComplexity is simple", () => {
    const result = validateComplexity(
      [makeSubStory({ complexity: "simple" })],
      "simple",
    );
    expect(result.valid).toBe(true);
  });

  test("medium substory is valid when maxComplexity is complex", () => {
    const result = validateComplexity(
      [makeSubStory({ complexity: "medium" })],
      "complex",
    );
    expect(result.valid).toBe(true);
  });

  test("complex substory is valid when maxComplexity is expert", () => {
    const result = validateComplexity(
      [makeSubStory({ complexity: "complex" })],
      "expert",
    );
    expect(result.valid).toBe(true);
  });

  test("returns valid=true with empty substories list", () => {
    const result = validateComplexity([], "simple");
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exceeds limit — LLM-assigned complexity too high
// ---------------------------------------------------------------------------

describe("validateComplexity — exceeds maxComplexity", () => {
  test("returns valid=false when a substory exceeds maxComplexity", () => {
    const substories = [
      makeSubStory({ id: "SD-001-1", complexity: "complex" }),
    ];
    const result = validateComplexity(substories, "medium");
    expect(result.valid).toBe(false);
  });

  test("produces an error for substory exceeding maxComplexity", () => {
    const substories = [
      makeSubStory({ id: "SD-001-1", complexity: "expert" }),
    ];
    const result = validateComplexity(substories, "medium");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("error message references the substory ID", () => {
    const substories = [
      makeSubStory({ id: "SD-001-9", complexity: "expert" }),
    ];
    const result = validateComplexity(substories, "simple");
    expect(result.errors.join(" ")).toContain("SD-001-9");
  });

  test("error message references the assigned complexity", () => {
    const substories = [
      makeSubStory({ id: "SD-001-1", complexity: "expert" }),
    ];
    const result = validateComplexity(substories, "medium");
    const msg = result.errors.join(" ");
    expect(msg).toContain("expert");
  });

  test("error message references the maxComplexity limit", () => {
    const substories = [
      makeSubStory({ id: "SD-001-1", complexity: "complex" }),
    ];
    const result = validateComplexity(substories, "medium");
    const msg = result.errors.join(" ");
    expect(msg).toContain("medium");
  });

  test("expert substory is rejected when maxComplexity is simple", () => {
    const result = validateComplexity(
      [makeSubStory({ complexity: "expert" })],
      "simple",
    );
    expect(result.valid).toBe(false);
  });

  test("complex substory is rejected when maxComplexity is simple", () => {
    const result = validateComplexity(
      [makeSubStory({ complexity: "complex" })],
      "simple",
    );
    expect(result.valid).toBe(false);
  });

  test("medium substory is rejected when maxComplexity is simple", () => {
    const result = validateComplexity(
      [makeSubStory({ complexity: "medium" })],
      "simple",
    );
    expect(result.valid).toBe(false);
  });

  test("produces one error per violating substory", () => {
    const substories = [
      makeSubStory({ id: "SD-001-1", complexity: "expert" }),
      makeSubStory({ id: "SD-001-2", complexity: "expert" }),
      makeSubStory({ id: "SD-001-3", complexity: "simple" }),
    ];
    const result = validateComplexity(substories, "medium");
    expect(result.errors.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// classifyComplexity cross-check
// ---------------------------------------------------------------------------

describe("validateComplexity — classifyComplexity cross-check", () => {
  test("adds a warning when classifyComplexity disagrees with LLM-assigned complexity", () => {
    // LLM says "simple" but story has many complex keywords — classifier will say higher
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        title: "Implement distributed consensus algorithm with fault tolerance",
        description: "Build a distributed Raft consensus algorithm with leader election, fault tolerance, and log replication",
        acceptanceCriteria: [
          "Leader election works under partition",
          "Log replication is linearizable",
          "Network partition handling is correct",
          "Byzantine fault tolerance is verified",
          "Consensus is achieved within 500ms",
          "Leader failover completes in under 1s",
          "Split-brain scenarios are prevented",
          "Audit log captures all state transitions",
          "Integration tests pass under simulated faults",
        ],
        tags: ["distributed", "consensus", "fault-tolerance"],
        complexity: "simple", // LLM says simple — classifier should say expert/complex
      }),
    ];
    const result = validateComplexity(substories, "expert");
    // Result should be valid (not exceeding max), but should warn about classifier disagreement
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("no warning when classifyComplexity agrees with LLM-assigned complexity", () => {
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        title: "Fix typo in README",
        description: "Correct a spelling mistake in the documentation",
        acceptanceCriteria: ["Typo is corrected"],
        tags: [],
        complexity: "simple",
      }),
    ];
    const result = validateComplexity(substories, "expert");
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
