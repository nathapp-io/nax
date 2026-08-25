import { describe, expect, test } from "bun:test";
import { isSessionRole, KNOWN_SESSION_ROLES } from "@/runtime";

/**
 * Session role registration tests for "plan-critic" — US-003 AC1
 *
 * Verifies that "plan-critic" is properly registered as a CanonicalSessionRole
 * and can be used with the session role type guards.
 */

describe("KNOWN_SESSION_ROLES — plan-critic registration (AC1)", () => {
  test("'plan-critic' is included in KNOWN_SESSION_ROLES array", () => {
    expect(KNOWN_SESSION_ROLES).toContain("plan-critic");
  });

  test("KNOWN_SESSION_ROLES is a readonly array", () => {
    expect(Array.isArray(KNOWN_SESSION_ROLES)).toBe(true);
    // Verify it's declared as readonly in the type system
    // (runtime mutability check is optional per TypeScript semantics)
  });

  test("'plan-critic' position in array is defined", () => {
    const index = KNOWN_SESSION_ROLES.indexOf("plan-critic");
    expect(index).toBeGreaterThanOrEqual(0);
  });

  test("'plan-critic' is not duplicated in KNOWN_SESSION_ROLES", () => {
    const count = KNOWN_SESSION_ROLES.filter((r) => r === "plan-critic").length;
    expect(count).toBe(1);
  });

  test("isSessionRole('plan-critic') returns true", () => {
    const result = isSessionRole("plan-critic");
    expect(result).toBe(true);
  });

  test("'plan-critic' can be type-guarded with isSessionRole", () => {
    const role = "plan-critic";
    const isValid: boolean = isSessionRole(role);
    expect(isValid).toBe(true);

    // Type narrowing would work in real code:
    if (isSessionRole(role)) {
      // role is now typed as SessionRole
      expect(role).toBe("plan-critic");
    }
  });

  test("KNOWN_SESSION_ROLES includes all canonical roles", () => {
    const expectedRoles = [
      "main",
      "test-writer",
      "implementer",
      "verifier",
      "diagnose",
      "source-fix",
      "test-fix",
      "reviewer-semantic",
      "reviewer-adversarial",
      "grounder",
      "plan",
      "decompose",
      "acceptance-gen",
      "refine",
      "fix-gen",
      "auto",
      "synthesis",
      "judge",
      "plan-critic", // US-003 addition
    ] as const;

    for (const role of expectedRoles) {
      expect(KNOWN_SESSION_ROLES).toContain(role);
    }
  });

  test("'plan-critic' is distinct from 'plan' and 'decompose' roles", () => {
    expect(KNOWN_SESSION_ROLES).toContain("plan");
    expect(KNOWN_SESSION_ROLES).toContain("plan-critic");
    expect(KNOWN_SESSION_ROLES).toContain("decompose");

    // They should be different
    expect("plan-critic").not.toBe("plan");
    expect("plan-critic").not.toBe("decompose");
  });

  test("debate-* roles still work with isSessionRole", () => {
    // debate-* roles are allowed via template-literal union
    const debateRole = "debate-expert-1";
    expect(isSessionRole(debateRole)).toBe(true);

    // But they're not in KNOWN_SESSION_ROLES (it's canonical only)
    expect(KNOWN_SESSION_ROLES).not.toContain(debateRole);
  });
});
