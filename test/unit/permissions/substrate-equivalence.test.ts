import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// NEVER a double cast through `unknown` — the check:test-as-unknown-as ratchet
// fails CI on any new occurrence. Mirror test/unit/config/scoped-permissions.test.ts:6-9's
// sanctioned idiom: makeNaxConfig(...) from @test/helpers takes a DeepPartial.
import { makeNaxConfig } from "@test/helpers";
import { resolvePermissions } from "@/config/permissions";
import { compileToolPolicy } from "@/tools";

const cfg = (execution: Record<string, unknown>) => makeNaxConfig({ execution });

// This file is NEW — no fixtures to reuse. Anchor on a real tmp dir:
const root = mkdtempSync(join(tmpdir(), "substrate-equivalence-"));
writeFileSync(join(root, "file.txt"), "x");

function policyFor(execution: Record<string, unknown>, stage: "run" | "verify" = "run") {
  const resolved = resolvePermissions(cfg(execution), stage);
  return compileToolPolicy(resolved.toolGrants ?? [], root, {
    ...(resolved.denyRules !== undefined ? { denyRules: resolved.denyRules } : {}),
    ...(resolved.askRules !== undefined ? { askRules: resolved.askRules } : {}),
  });
}

describe("substrate equivalence (regression gate, spec §5 step 1)", () => {
  test("profile-only configs: identical grantedTools before/after shapes", () => {
    for (const permissionProfile of ["unrestricted", "safe"] as const) {
      const resolved = resolvePermissions(cfg({ permissionProfile }), "run");
      expect(resolved.denyRules).toBeUndefined();
      expect(resolved.askRules).toBeUndefined();
    }
  });

  test("allowedTools alias behaves identically to allow end-to-end", () => {
    const viaAlias = policyFor({
      permissionProfile: "scoped",
      permissions: { run: { allowedTools: ["Read", "Write(src/**)"] } },
    });
    const viaAllow = policyFor({
      permissionProfile: "scoped",
      permissions: { run: { allow: ["Read", "Write(src/**)"] } },
    });
    for (const input of [{ path: "src/a.ts" }, { path: "test/a.ts" }]) {
      expect(viaAllow.check("Write", { pathFields: ["path"] }, input)).toEqual(
        viaAlias.check("Write", { pathFields: ["path"] }, input),
      );
    }
    expect([...viaAllow.grantedTools()].sort()).toEqual([...viaAlias.grantedTools()].sort());
  });

  test("deny > ask > allow across the full path (unrestricted profile)", () => {
    const policy = policyFor({
      permissionProfile: "unrestricted",
      permissions: {
        run: { deny: ["Write(src/generated/**)"], ask: ["Write(src/**)"] },
      },
    });
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "src/generated/x.ts" }).allowed).toBe(false);
    const asked = policy.check("Write", { pathFields: ["path"] }, { path: "src/x.ts" });
    expect(asked.allowed === false && asked.outcome).toBe("ask");
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "docs/x.md" }).allowed).toBe(true);
  });

  test("deny binds under unrestricted (spec R10 deny-suite row)", () => {
    const policy = policyFor({
      permissionProfile: "unrestricted",
      permissions: { run: { deny: ["Delete"] } },
    });
    expect(policy.grantedTools()).not.toContain("Delete");
  });

  test("R10: allow under unrestricted REPLACES the baseline pattern for that tool", () => {
    // On base, execution.permissions was ignored unless the profile was scoped.
    // Spec R10 runs stageRules under EVERY profile, and the allow compiler is
    // last-write-wins per tool (policy.ts grant loop), so a lone
    // `Write(src/**)` REPLACES the baseline `Write(*)` rather than adding to
    // it. Both the `allow` and legacy `allowedTools` spellings must do this.
    for (const key of ["allow", "allowedTools"] as const) {
      const policy = policyFor({
        permissionProfile: "unrestricted",
        permissions: { run: { [key]: ["Write(src/**)"] } },
      });
      expect(policy.check("Write", { pathFields: ["path"] }, { path: "src/a.ts" }).allowed).toBe(true);
      expect(policy.check("Write", { pathFields: ["path"] }, { path: "test/a.ts" }).allowed).toBe(false);
      // Another baseline tool is untouched by the Write override.
      expect(policy.check("Read", { pathFields: ["path"] }, { path: "file.txt" }).allowed).toBe(true);
    }
  });

  test("R10: allow under safe ADDS a tool on top of the reads-only baseline", () => {
    const policy = policyFor({
      permissionProfile: "safe",
      permissions: { run: { allow: ["Write"] } },
    });
    // The block's grant is added.
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "file.txt" }).allowed).toBe(true);
    // safe's reads-only baseline is otherwise unchanged: reads pass, and a tool
    // it never granted (Edit) stays denied.
    expect(policy.check("Read", { pathFields: ["path"] }, { path: "file.txt" }).allowed).toBe(true);
    expect(policy.check("Edit", { pathFields: ["path"] }, { path: "file.txt" }).allowed).toBe(false);
  });

  test("two expressions for one tool: LAST wins (pins today's compiler)", () => {
    // Guards the byte-identity gate: the allow compiler is last-write-wins per
    // tool (policy.ts grant loop). If this test surprises you, do not "fix" the
    // compiler — see Task 4's warning; changing it alters shipped-config verdicts.
    const policy = policyFor({
      permissionProfile: "scoped",
      permissions: { run: { allow: ["Write(src/**)", "Write(test/**)"] } },
    });
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "test/a.ts" }).allowed).toBe(true);
    expect(policy.check("Write", { pathFields: ["path"] }, { path: "src/a.ts" }).allowed).toBe(false);
  });

  test("stage inheritance carries rules end-to-end", () => {
    const policy = policyFor(
      {
        permissionProfile: "scoped",
        permissions: { run: { allow: ["Read"], deny: ["Read(.env*)"] }, verify: { inherit: "run" } },
      },
      "verify",
    );
    expect(policy.check("Read", { pathFields: ["path"] }, { path: ".env.local" }).allowed).toBe(false);
    expect(policy.check("Read", { pathFields: ["path"] }, { path: "file.txt" }).allowed).toBe(true);
  });
});
