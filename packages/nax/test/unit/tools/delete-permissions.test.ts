import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { resolvePermissions } from "@/config/permissions";

describe("Delete wiring", () => {
  test("the unrestricted profile grants Delete", () => {
    // makeNaxConfig, not a raw literal: `.nax/rules/test-helpers.md` forbids
    // re-implementing shared fixtures inline, and a bare object literal does
    // not narrow permissionProfile to its union type.
    const { toolGrants } = resolvePermissions(
      makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }),
      "run",
    );
    expect((toolGrants ?? []).map((g) => g.tool)).toContain("Delete");
  });

  test("the safe profile does NOT grant Delete", () => {
    const { toolGrants } = resolvePermissions(makeNaxConfig({ execution: { permissionProfile: "safe" } }), "run");
    expect((toolGrants ?? []).map((g) => g.tool)).not.toContain("Delete");
  });
});
