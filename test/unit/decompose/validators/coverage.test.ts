/**
 * Tests for coverage validator.
 *
 * AC: Coverage validator warns when original AC has no matching substory AC.
 *     Uses keyword matching to map each original AC to at least one substory AC.
 */

import { describe, test, expect } from "bun:test";
import { validateCoverage } from "../../../../src/decompose/validators/coverage";
import type { SubStory } from "../../../../src/decompose/types";
import type { UserStory } from "../../../../src/prd";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOriginalStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "SD-001",
    title: "User authentication system",
    description: "Implement complete user authentication",
    acceptanceCriteria: [
      "User can register with email and password",
      "User can log in with valid credentials",
      "User can reset forgotten password",
      "Session expires after 24 hours",
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

function makeSubStory(overrides: Partial<SubStory> = {}): SubStory {
  return {
    id: "SD-001-1",
    parentStoryId: "SD-001",
    title: "User registration flow",
    description: "Handle user registration",
    acceptanceCriteria: ["User can register with email and password"],
    tags: ["auth"],
    dependencies: [],
    complexity: "simple",
    nonOverlapJustification: "Only registration",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Full coverage — all original ACs matched
// ---------------------------------------------------------------------------

describe("validateCoverage — full coverage", () => {
  test("returns valid=true when all original ACs are covered by substory ACs", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        acceptanceCriteria: ["User can register with email and password"],
      }),
      makeSubStory({
        id: "SD-001-2",
        acceptanceCriteria: ["User can log in with valid credentials"],
      }),
      makeSubStory({
        id: "SD-001-3",
        acceptanceCriteria: ["User can reset forgotten password"],
      }),
      makeSubStory({
        id: "SD-001-4",
        acceptanceCriteria: ["Session expires after 24 hours"],
      }),
    ];
    const result = validateCoverage(original, substories);
    expect(result.valid).toBe(true);
  });

  test("returns no warnings when all original ACs have keyword matches", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        acceptanceCriteria: ["User can register with email and password"],
      }),
      makeSubStory({
        id: "SD-001-2",
        acceptanceCriteria: ["User can log in with valid credentials"],
      }),
      makeSubStory({
        id: "SD-001-3",
        acceptanceCriteria: ["User can reset forgotten password"],
      }),
      makeSubStory({
        id: "SD-001-4",
        acceptanceCriteria: ["Session expires after 24 hours"],
      }),
    ];
    const result = validateCoverage(original, substories);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns no errors when coverage is complete", () => {
    const original = makeOriginalStory();
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        acceptanceCriteria: ["User can register with email and password"],
      }),
      makeSubStory({
        id: "SD-001-2",
        acceptanceCriteria: ["User can log in with valid credentials"],
      }),
      makeSubStory({
        id: "SD-001-3",
        acceptanceCriteria: ["User can reset forgotten password"],
      }),
      makeSubStory({
        id: "SD-001-4",
        acceptanceCriteria: ["Session expires after 24 hours"],
      }),
    ];
    const result = validateCoverage(original, substories);
    expect(result.errors).toHaveLength(0);
  });

  test("keyword match is sufficient — exact AC text not required", () => {
    const original = makeOriginalStory({
      acceptanceCriteria: ["User can register with email and password"],
    });
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        // Paraphrase but same keywords
        acceptanceCriteria: ["Registration flow accepts email address and password"],
      }),
    ];
    const result = validateCoverage(original, substories);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Partial coverage — some original ACs unmatched
// ---------------------------------------------------------------------------

describe("validateCoverage — partial coverage", () => {
  test("produces a warning for each unmatched original AC", () => {
    const original = makeOriginalStory({
      acceptanceCriteria: [
        "User can register with email and password",
        "User can log in with valid credentials",
        "User can reset forgotten password",
        "Session expires after 24 hours",
      ],
    });
    // Only covers registration — 3 ACs unmatched
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        acceptanceCriteria: ["User can register with email and password"],
      }),
    ];
    const result = validateCoverage(original, substories);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  test("warning message references the unmatched original AC text", () => {
    const missingAC = "User can reset forgotten password";
    const original = makeOriginalStory({
      acceptanceCriteria: [
        "User can register with email and password",
        missingAC,
      ],
    });
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        acceptanceCriteria: ["User can register with email and password"],
      }),
    ];
    const result = validateCoverage(original, substories);
    const allMessages = [...result.warnings, ...result.errors].join(" ");
    expect(allMessages.toLowerCase()).toContain("reset");
  });

  test("valid remains true when there are only warnings (no errors)", () => {
    const original = makeOriginalStory({
      acceptanceCriteria: ["covered criterion", "uncovered unique criterion xyzzy"],
    });
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        acceptanceCriteria: ["covered criterion satisfied"],
      }),
    ];
    const result = validateCoverage(original, substories);
    // Coverage produces warnings, not errors
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No coverage — all original ACs unmatched
// ---------------------------------------------------------------------------

describe("validateCoverage — no coverage", () => {
  test("produces warnings for every original AC when substories have empty ACs", () => {
    const original = makeOriginalStory({
      acceptanceCriteria: ["AC one", "AC two", "AC three"],
    });
    const substories = [
      makeSubStory({
        id: "SD-001-1",
        acceptanceCriteria: [],
      }),
    ];
    const result = validateCoverage(original, substories);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  test("produces warnings for all ACs when substories list is empty", () => {
    const original = makeOriginalStory({
      acceptanceCriteria: ["register user", "login user", "logout user"],
    });
    const result = validateCoverage(original, []);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });

  test("handles original story with no ACs gracefully", () => {
    const original = makeOriginalStory({ acceptanceCriteria: [] });
    const substories = [makeSubStory()];
    const result = validateCoverage(original, substories);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
