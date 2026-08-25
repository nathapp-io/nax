import { describe, expect, test } from "bun:test";
import { isSessionRole, KNOWN_SESSION_ROLES } from "@/runtime";

/**
 * Session role registration tests for the finish review/fix/narrative roles
 * (Task 6 of the finish-review-ops plan).
 *
 * Verifies "finish-review-spec", "finish-review-quality", "finish-fix", and
 * "finish-narrative" are registered as CanonicalSessionRole members and can be
 * used with the session role type guards. Follows the shape established by
 * session-role-plan-critic.test.ts.
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
