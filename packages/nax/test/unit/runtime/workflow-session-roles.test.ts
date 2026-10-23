import { describe, expect, test } from "bun:test";
import { isSessionRole, KNOWN_SESSION_ROLES } from "@/runtime/session-role";

describe("workflow session roles", () => {
  test.each(["wf-implementer", "wf-story-review", "wf-rereview", "wf-branch-review", "wf-branch-fix"])(
    "%s is a known role",
    (role) => {
      expect(KNOWN_SESSION_ROLES).toContain(role as (typeof KNOWN_SESSION_ROLES)[number]);
      expect(isSessionRole(role)).toBe(true);
    },
  );
});

/**
 * US-001 — a repair is its own session role, not an extra branch fix. The token
 * meter keys `byRole` on the dispatch's `sessionRole`, so the role has to be
 * registered here or the repair books against `wf-branch-fix` and the ledger
 * cannot tell a repair from a branch fix.
 *
 * The widened `readonly string[]` bindings are what keep these runtime checks
 * rather than compile errors while the role is still missing.
 */
describe("workflow session roles — wf-repair (US-001)", () => {
  test("AC-1: isSessionRole('wf-repair') returns true", () => {
    expect(isSessionRole("wf-repair")).toBe(true);
  });

  test("AC-2: KNOWN_SESSION_ROLES contains 'wf-repair'", () => {
    const roles: readonly string[] = KNOWN_SESSION_ROLES;
    expect(roles).toContain("wf-repair");
  });

  test("AC-2 boundary: 'wf-repair' is registered exactly once", () => {
    const roles: readonly string[] = KNOWN_SESSION_ROLES;
    expect(roles.filter((role) => role === "wf-repair")).toHaveLength(1);
  });

  test("AC-2 boundary: a near-miss role is still rejected", () => {
    expect(isSessionRole("wf-repairs")).toBe(false);
    expect(isSessionRole("repair")).toBe(false);
  });
});
