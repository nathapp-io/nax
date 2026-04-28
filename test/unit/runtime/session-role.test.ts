import { describe, expect, test } from "bun:test";
import { isSessionRole, KNOWN_SESSION_ROLES } from "../../../src/runtime/session-role";
import type { SessionRole } from "../../../src/runtime/session-role";

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
      "main", "test-writer", "implementer", "verifier",
      "diagnose", "source-fix", "test-fix",
      "reviewer-semantic", "reviewer-adversarial",
      "plan", "decompose",
      "acceptance-gen", "refine", "fix-gen",
      "auto", "synthesis", "judge",
    ] as SessionRole[])("returns true for canonical role: %s", (role) => {
      expect(isSessionRole(role)).toBe(true);
    });

    test.each([
      "debate-plan",
      "debate-round-1",
      "debate-adversarial-review",
    ])("returns true for debate-prefixed role: %s", (role) => {
      expect(isSessionRole(role)).toBe(true);
    });

    test.each([
      "unknown-role",
      "MAIN",
      "runner",
      "",
      "debate",
    ])("returns false for non-role string: %s", (nonRole) => {
      expect(isSessionRole(nonRole)).toBe(false);
    });
  });
});
