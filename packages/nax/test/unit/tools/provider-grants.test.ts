import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { resolvePermissions } from "@/config/permissions";
import { compileToolPolicy } from "@/tools";
import { expandProviderGrants } from "@/tools/provider-grants";

describe("expandProviderGrants", () => {
  test("emits one grant per namespaced tool name", () => {
    expect(
      expandProviderGrants([{ providerId: "codebase-memory", localNames: ["search_graph", "trace_path"] }]),
    ).toEqual([
      { tool: "codebase-memory__search_graph", patterns: ["*"] },
      { tool: "codebase-memory__trace_path", patterns: ["*"] },
    ]);
  });

  test("emits nothing for a provider with no granted tools", () => {
    expect(expandProviderGrants([{ providerId: "rtk", localNames: [] }])).toEqual([]);
  });

  test("the compiled policy grants the namespaced names and no keyword", () => {
    // The regression that matters: a grant surviving in parsed shape would
    // compile to the key "Mcp" and deny every call at runtime.
    const policy = compileToolPolicy(
      expandProviderGrants([{ providerId: "codebase-memory", localNames: ["search_graph"] }]),
      "/tmp",
    );
    const granted = policy.grantedTools();
    expect(granted).toContain("codebase-memory__search_graph");
    expect(granted).not.toContain("Mcp");
    expect(granted).not.toContain("codebase-memory");
  });

  test("a granted provider tool passes the policy check; an ungranted provider tool is denied", () => {
    const policy = compileToolPolicy(expandProviderGrants([{ providerId: "rtk", localNames: ["recall"] }]), "/tmp");
    expect(policy.check("rtk__recall", { pathFields: [] }, {}).allowed).toBe(true);
    expect(policy.check("rtk__other", { pathFields: [] }, {}).allowed).toBe(false);
  });
});

test("unrestricted grants no provider tool", () => {
  // permissions.ts enumerates its built-ins rather than wildcarding, so
  // provider tools are excluded by construction. This locks that in.
  const { toolGrants } = resolvePermissions(makeNaxConfig({ execution: { permissionProfile: "unrestricted" } }), "run");
  expect((toolGrants ?? []).some((g) => g.tool.includes("__"))).toBe(false);
});

test("safe grants no provider tool", () => {
  const { toolGrants } = resolvePermissions(makeNaxConfig({ execution: { permissionProfile: "safe" } }), "run");
  expect((toolGrants ?? []).some((g) => g.tool.includes("__"))).toBe(false);
});
