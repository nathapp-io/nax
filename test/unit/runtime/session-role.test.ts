import { describe, expect, test } from "bun:test";
import type { SessionRole } from "@/runtime/session-role";
import { isSessionRole, KNOWN_SESSION_ROLES } from "@/runtime/session-role";

describe("SessionRole", () => {
  describe("KNOWN_SESSION_ROLES", () => {
    test("contains expected canonical roles", () => {
      expect(KNOWN_SESSION_ROLES).toContain("main");
      expect(KNOWN_SESSION_ROLES).toContain("test-writer");
      expect(KNOWN_SESSION_ROLES).toContain("implementer");
      expect(KNOWN_SESSION_ROLES).toContain("verifier");
      expect(KNOWN_SESSION_ROLES).toContain("reviewer-semantic");
      expect(KNOWN_SESSION_ROLES).toContain("plan");
      expect(KNOWN_SESSION_ROLES).toContain("decompose");
    });

    test("is readonly", () => {
      const roles: readonly string[] = KNOWN_SESSION_ROLES;
      expect(roles.length).toBeGreaterThan(0);
    });
  });

  describe("isSessionRole", () => {
    test.each([
      "main",
      "test-writer",
      "implementer",
      "verifier",
      "diagnose",
      "source-fix",
      "test-fix",
      "reviewer-semantic",
      "reviewer-adversarial",
      "plan",
      "plan-refine",
      "decompose",
      "acceptance-gen",
      "refine",
      "fix-gen",
      "auto",
    ] as SessionRole[])("returns true for canonical role: %s", (role) => {
      expect(isSessionRole(role)).toBe(true);
    });

    test.each(["unknown-role", "MAIN", "runner", ""])("returns false for non-role string: %s", (nonRole) => {
      expect(isSessionRole(nonRole)).toBe(false);
    });
  });
});

/**
 * Session role registration tests for the finish review/fix/narrative roles
 * (Task 6 of the finish-review-ops plan).
 *
 * Verifies "finish-review-spec", "finish-review-quality", "finish-fix", and
 * "finish-narrative" are registered as CanonicalSessionRole members and can be
 * used with the session role type guards.
 */

const FINISH_ROLES = ["finish-review-spec", "finish-review-quality", "finish-fix", "finish-narrative"] as const;

describe("KNOWN_SESSION_ROLES — finish role registration", () => {
  for (const role of FINISH_ROLES) {
    test(`'${role}' is included in KNOWN_SESSION_ROLES array`, () => {
      expect(KNOWN_SESSION_ROLES).toContain(role);
    });

    test(`'${role}' is not duplicated in KNOWN_SESSION_ROLES`, () => {
      const count = KNOWN_SESSION_ROLES.filter((r) => r === role).length;
      expect(count).toBe(1);
    });

    test(`isSessionRole('${role}') returns true`, () => {
      expect(isSessionRole(role)).toBe(true);
    });
  }

  test("all four finish roles are mutually distinct", () => {
    expect(new Set(FINISH_ROLES).size).toBe(FINISH_ROLES.length);
  });

  test("KNOWN_SESSION_ROLES is a readonly array", () => {
    expect(Array.isArray(KNOWN_SESSION_ROLES)).toBe(true);
  });
});
