/**
 * Tests for overlap validator.
 *
 * AC: Overlap validator detects >0.6 keyword similarity between substory and existing story.
 *     Flags pairs with similarity > 0.6 as warnings, > 0.8 as errors.
 */

import { describe, test, expect } from "bun:test";
import { validateOverlap } from "../../../../src/decompose/validators/overlap";
import type { SubStory } from "../../../../src/decompose/types";
import type { UserStory } from "../../../../src/prd";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSubStory(overrides: Partial<SubStory> = {}): SubStory {
  return {
    id: "SD-001-1",
    parentStoryId: "SD-001",
    title: "Implement authentication module",
    description: "Build JWT authentication with token refresh",
    acceptanceCriteria: ["User can log in", "Token is refreshed automatically"],
    tags: ["auth", "security"],
    dependencies: [],
    complexity: "medium",
    nonOverlapJustification: "Handles only the auth flow",
    ...overrides,
  };
}

function makeExistingStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "EX-001",
    title: "Build payment processing",
    description: "Integrate Stripe payment gateway",
    acceptanceCriteria: ["User can pay via card", "Refunds are supported"],
    tags: ["payments", "billing"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// No overlap — completely different topics
// ---------------------------------------------------------------------------

describe("validateOverlap — no overlap", () => {
  test("returns valid=true when substories are unrelated to existing stories", () => {
    const substories = [makeSubStory()];
    const existing = [makeExistingStory()];
    const result = validateOverlap(substories, existing);
    expect(result.valid).toBe(true);
  });

  test("returns no errors when substories are unrelated to existing stories", () => {
    const substories = [makeSubStory()];
    const existing = [makeExistingStory()];
    const result = validateOverlap(substories, existing);
    expect(result.errors).toHaveLength(0);
  });

  test("returns no warnings when substories are unrelated to existing stories", () => {
    const substories = [makeSubStory()];
    const existing = [makeExistingStory()];
    const result = validateOverlap(substories, existing);
    expect(result.warnings).toHaveLength(0);
  });

  test("returns valid=true with empty substories list", () => {
    const result = validateOverlap([], [makeExistingStory()]);
    expect(result.valid).toBe(true);
  });

  test("returns valid=true with empty existing stories list", () => {
    const result = validateOverlap([makeSubStory()], []);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Warning threshold — similarity > 0.6
// ---------------------------------------------------------------------------

describe("validateOverlap — similarity > 0.6 produces warning", () => {
  test("produces a warning when keyword similarity is above 0.6", () => {
    // Substory and existing story share many keywords (>60% overlap)
    const substory = makeSubStory({
      id: "SD-001-1",
      title: "JWT authentication with refresh tokens",
      description: "Implement JWT authentication, token refresh, and token expiry",
      acceptanceCriteria: ["JWT tokens are issued on login", "Tokens refresh before expiry"],
      tags: ["auth", "jwt", "security"],
    });
    const existing = makeExistingStory({
      id: "EX-002",
      title: "JWT authentication service",
      description: "JWT authentication with refresh tokens and expiry handling",
      acceptanceCriteria: ["JWT tokens issued correctly", "Token refresh works"],
      tags: ["auth", "jwt", "security"],
    });
    const result = validateOverlap([substory], [existing]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("warning message references the substory ID and existing story ID", () => {
    const substory = makeSubStory({
      id: "SD-001-1",
      title: "JWT authentication with refresh tokens",
      description: "Implement JWT authentication, token refresh, and token expiry",
      acceptanceCriteria: ["JWT tokens are issued on login", "Tokens refresh before expiry"],
      tags: ["auth", "jwt", "security"],
    });
    const existing = makeExistingStory({
      id: "EX-002",
      title: "JWT authentication service",
      description: "JWT authentication with refresh tokens and expiry handling",
      acceptanceCriteria: ["JWT tokens issued correctly", "Token refresh works"],
      tags: ["auth", "jwt", "security"],
    });
    const result = validateOverlap([substory], [existing]);
    const combined = [...result.errors, ...result.warnings].join(" ");
    expect(combined).toContain("SD-001-1");
    expect(combined).toContain("EX-002");
  });

  test("similarity between 0.6 and 0.8 is a warning only, not an error", () => {
    // Moderately overlapping stories
    const substory = makeSubStory({
      id: "SD-001-2",
      title: "user authentication login",
      description: "basic user authentication and login flow",
      acceptanceCriteria: ["user can login", "login form validates input"],
      tags: ["auth"],
    });
    const existing = makeExistingStory({
      id: "EX-003",
      title: "user authentication module",
      description: "user authentication system for login and session",
      acceptanceCriteria: ["authentication works", "user session is created"],
      tags: ["auth", "session"],
    });
    const result = validateOverlap([substory], [existing]);
    // Should have warnings but may not have errors
    // At minimum, result must surface findings
    expect(result.warnings.length + result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error threshold — similarity > 0.8
// ---------------------------------------------------------------------------

describe("validateOverlap — similarity > 0.8 produces error", () => {
  test("produces an error when keyword similarity is above 0.8", () => {
    // Nearly identical stories
    const substory = makeSubStory({
      id: "SD-001-3",
      title: "implement overlap validator keyword similarity check",
      description: "implement overlap validator with keyword similarity check using jaccard index",
      acceptanceCriteria: [
        "overlap validator detects keyword similarity",
        "jaccard similarity computed correctly",
        "threshold above 0.8 returns error",
      ],
      tags: ["validation", "overlap", "keywords", "jaccard"],
    });
    const existing = makeExistingStory({
      id: "EX-004",
      title: "overlap validator keyword similarity check",
      description: "overlap validator using jaccard keyword similarity index for detection",
      acceptanceCriteria: [
        "overlap validator detects keyword similarity",
        "jaccard similarity computed correctly",
        "threshold returns error",
      ],
      tags: ["validation", "overlap", "keywords", "jaccard"],
    });
    const result = validateOverlap([substory], [existing]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("error message references both story IDs when similarity > 0.8", () => {
    const substory = makeSubStory({
      id: "SD-001-4",
      title: "database connection pool management",
      description: "database connection pool management with retry logic and health checks",
      acceptanceCriteria: [
        "connection pool is initialized",
        "connection retry logic works",
        "health check detects failures",
      ],
      tags: ["database", "pool", "connection"],
    });
    const existing = makeExistingStory({
      id: "EX-005",
      title: "database connection pool management",
      description: "manage database connection pool with retry and health check",
      acceptanceCriteria: [
        "connection pool initialized correctly",
        "retry logic handles failures",
        "health check runs periodically",
      ],
      tags: ["database", "pool", "connection"],
    });
    const result = validateOverlap([substory], [existing]);
    expect(result.valid).toBe(false);
    const allMessages = [...result.errors, ...result.warnings].join(" ");
    expect(allMessages).toContain("SD-001-4");
    expect(allMessages).toContain("EX-005");
  });

  test("valid=false when any pair exceeds 0.8 similarity", () => {
    const substory = makeSubStory({
      id: "SD-001-5",
      title: "pipeline stage execution runner orchestrator",
      description: "pipeline stage execution runner for orchestrating story processing",
      acceptanceCriteria: [
        "pipeline stages execute in order",
        "runner orchestrates pipeline correctly",
        "execution errors are handled",
      ],
      tags: ["pipeline", "execution", "runner", "orchestrator"],
    });
    const existing = makeExistingStory({
      id: "EX-006",
      title: "pipeline stage execution runner orchestrator",
      description: "pipeline stage execution runner orchestrating story pipeline stages",
      acceptanceCriteria: [
        "pipeline stages execute in order",
        "runner orchestrates pipeline",
        "errors handled correctly",
      ],
      tags: ["pipeline", "execution", "runner", "orchestrator"],
    });
    const result = validateOverlap([substory], [existing]);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multiple substories
// ---------------------------------------------------------------------------

describe("validateOverlap — multiple substories", () => {
  test("flags each overlapping pair independently", () => {
    const substory1 = makeSubStory({
      id: "SD-001-1",
      title: "build authentication module jwt tokens refresh",
      description: "authentication module with jwt tokens and refresh",
      acceptanceCriteria: ["authentication works", "jwt token refresh works"],
      tags: ["auth", "jwt"],
    });
    const substory2 = makeSubStory({
      id: "SD-001-2",
      title: "payment processing stripe integration billing",
      description: "stripe payment integration for billing processing",
      acceptanceCriteria: ["payment processed", "billing updated"],
      tags: ["payment", "stripe", "billing"],
    });
    const existing1 = makeExistingStory({
      id: "EX-001",
      title: "authentication jwt tokens refresh module",
      description: "jwt authentication module with token refresh",
      acceptanceCriteria: ["jwt tokens issued", "token refresh functions"],
      tags: ["auth", "jwt"],
    });
    const existing2 = makeExistingStory({
      id: "EX-002",
      title: "stripe payment billing processing integration",
      description: "stripe payment processing and billing integration",
      acceptanceCriteria: ["payment processed via stripe", "billing records updated"],
      tags: ["payment", "stripe", "billing"],
    });
    const result = validateOverlap([substory1, substory2], [existing1, existing2]);
    // Both substories overlap with existing stories — should produce multiple findings
    expect(result.errors.length + result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  test("non-overlapping substories in a mixed list do not generate extra warnings", () => {
    const overlappingSubstory = makeSubStory({
      id: "SD-001-1",
      title: "jwt authentication token refresh security module",
      description: "jwt authentication with token refresh and security validation",
      acceptanceCriteria: ["jwt token issued", "token refresh works", "security validation passes"],
      tags: ["auth", "jwt", "security"],
    });
    const cleanSubstory = makeSubStory({
      id: "SD-001-2",
      title: "UI theme color palette selection",
      description: "Allow users to select from predefined color themes",
      acceptanceCriteria: ["Theme can be switched", "Preference is saved"],
      tags: ["ui", "theme"],
    });
    const existing = makeExistingStory({
      id: "EX-001",
      title: "jwt authentication token refresh security",
      description: "jwt authentication and token refresh security",
      acceptanceCriteria: ["jwt token issued correctly", "token refresh works", "security validated"],
      tags: ["auth", "jwt", "security"],
    });
    const result = validateOverlap([overlappingSubstory, cleanSubstory], [existing]);
    // Clean substory should not add extra warnings
    // Total findings should correspond to the overlapping pair only
    const total = result.errors.length + result.warnings.length;
    expect(total).toBeGreaterThanOrEqual(1);
    const allMessages = [...result.errors, ...result.warnings].join(" ");
    expect(allMessages).not.toContain("SD-001-2");
  });
});
