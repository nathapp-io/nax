import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { validatePermissionsBlock } from "@/config/config-guards";
import { resolvePermissions } from "@/config/permissions";
import { BASH_TOOL_NAME } from "@/tools";

const cfg = (execution: Record<string, unknown>) => makeNaxConfig({ execution });

describe("Bash is deny-all by default (spec R4)", () => {
  test.each(["unrestricted", "safe", "scoped"] as const)("%s grants no Bash", (permissionProfile) => {
    const resolved = resolvePermissions(cfg({ permissionProfile }), "run");
    expect((resolved.toolGrants ?? []).some((grant) => grant.tool === BASH_TOOL_NAME)).toBe(false);
  });

  test("an unset profile (the documented default) grants no Bash", () => {
    const resolved = resolvePermissions(cfg({}), "run");
    expect((resolved.toolGrants ?? []).some((grant) => grant.tool === BASH_TOOL_NAME)).toBe(false);
  });

  test("an explicit allow rule is the only way to grant it", () => {
    const resolved = resolvePermissions(
      cfg({ permissionProfile: "unrestricted", permissions: { run: { allow: ["Bash(bun test *)"] } } }),
      "run",
    );
    expect((resolved.toolGrants ?? []).filter((grant) => grant.tool === BASH_TOOL_NAME)).toEqual([
      { tool: "Bash", patterns: ["bun test *"] },
    ]);
  });

  test("Bash expressions are load-legal in every rule list", () => {
    expect(() =>
      validatePermissionsBlock({
        execution: {
          permissions: {
            run: { allow: ["Bash(bun test *)"], deny: ["Bash(git push *)"], ask: ["Bash(rm *)"] },
          },
        },
      }),
    ).not.toThrow();
  });
});
