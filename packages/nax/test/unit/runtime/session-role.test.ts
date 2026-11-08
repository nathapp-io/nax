import { describe, expect, test } from "bun:test";
import { isSessionRole, KNOWN_SESSION_ROLES, knownSessionRole } from "@/runtime/session-role";

/**
 * The roles US-003 removed from the canonical registry: they had no producer
 * left, so they are dead entries rather than live session roles.
 */
const REMOVED_ROLES = [
  "test-writer",
  "verifier",
  "diagnose",
  "source-fix",
  "test-fix",
  "repo-scoped-test-fix",
  "acceptance-gen",
  "refine",
  "fix-gen",
  "finish-review-spec",
  "finish-review-quality",
  "finish-fix",
  "nbf-worth-check",
  "decompose",
];

describe("SessionRole", () => {
  describe("KNOWN_SESSION_ROLES", () => {
    test("US-003 AC-1: the registry is the ordered list of live canonical roles", () => {
      expect(KNOWN_SESSION_ROLES).toEqual([
        "main",
        "implementer",
        "reviewer-semantic",
        "reviewer-adversarial",
        "reviewer-fix",
        "plan",
        "plan-refine",
        "auto",
        "setup",
        "advisor",
        "wf-implementer",
        "wf-story-review",
        "wf-rereview",
        "wf-branch-review",
        "wf-branch-fix",
        "wf-repair",
      ]);
    });

    test("is readonly", () => {
      const roles: readonly string[] = KNOWN_SESSION_ROLES;
      expect(roles.length).toBeGreaterThan(0);
    });
  });

  describe("isSessionRole", () => {
    test.each([...KNOWN_SESSION_ROLES])("returns true for the registered role: %s", (role) => {
      expect(isSessionRole(role)).toBe(true);
    });

    test.each(REMOVED_ROLES)("returns false for the removed role: %s", (role) => {
      expect(isSessionRole(role)).toBe(false);
    });

    test.each(["unknown-role", "MAIN", "runner", ""])("returns false for non-role string: %s", (nonRole) => {
      expect(isSessionRole(nonRole)).toBe(false);
    });
  });

  describe("knownSessionRole", () => {
    test("returns a known role unchanged", () => {
      expect(knownSessionRole("implementer")).toBe("implementer");
    });

    test("US-003 AC-2: reads a removed role as absent", () => {
      expect(knownSessionRole("test-writer")).toBeUndefined();
    });

    test.each(REMOVED_ROLES)("reads the removed role %s as absent", (role) => {
      expect(knownSessionRole(role)).toBeUndefined();
    });

    test("reads an unknown role as absent", () => {
      expect(knownSessionRole("plugin-private-role")).toBeUndefined();
    });

    test("reads an absent role as absent", () => {
      expect(knownSessionRole(undefined)).toBeUndefined();
    });
  });

  describe("KNOWN_SESSION_ROLES — roles removed by earlier waves", () => {
    test("'finish-narrative' was removed with the narrative op (A4)", () => {
      expect(isSessionRole("finish-narrative")).toBe(false);
      expect(KNOWN_SESSION_ROLES as readonly string[]).not.toContain("finish-narrative");
    });
  });

  /**
   * US-001 — the scoped fix review dispatches on its own session role. It is a
   * *fresh* reviewer distinct from the seeded pair, so the role has to be
   * registered here (adapter-wiring.md Rule 2: free-form sessionRole strings are
   * banned outside the registry, and an unregistered role would be a runtime
   * miss rather than a compile error).
   *
   * The widened `readonly string[]` binding is what lets this assertion stay a
   * runtime check instead of a compile error while the role is still missing.
   */
  describe("KNOWN_SESSION_ROLES — reviewer-fix registration (US-001)", () => {
    test("US-001 AC10: KNOWN_SESSION_ROLES contains 'reviewer-fix'", () => {
      const roles: readonly string[] = KNOWN_SESSION_ROLES;
      expect(roles).toContain("reviewer-fix");
    });

    test("US-001 AC10 boundary: isSessionRole('reviewer-fix') accepts the new role", () => {
      expect(isSessionRole("reviewer-fix")).toBe(true);
    });

    test("US-001 AC10 boundary: 'reviewer-fix' is registered exactly once", () => {
      const roles: readonly string[] = KNOWN_SESSION_ROLES;
      expect(roles.filter((role) => role === "reviewer-fix")).toHaveLength(1);
    });

    test("US-001 AC10 boundary: a near-miss role is still rejected", () => {
      expect(isSessionRole("reviewer-fix-scoped")).toBe(false);
    });
  });

  describe("advisor role (A1)", () => {
    test("advisor is a known session role", () => {
      expect(isSessionRole("advisor")).toBe(true);
      expect(KNOWN_SESSION_ROLES).toContain("advisor");
    });
  });
});
