import { describe, expect, test } from "bun:test";
import { type DeepPartial, makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { DEFAULT_CODING_TOOLS, resolvePermissions } from "@/config/permissions";

// makeNaxConfig is the sanctioned factory; resolvePermissions reads only
// `execution`. `permissions` is typed on ExecutionConfig, so no cast is needed —
// the cast ratchets (check:test-escape-hatches, check:test-as-unknown-as) forbid
// adding one. Mirror the existing idiom in test/unit/config/permissions.test.ts.
function configWith(execution: DeepPartial<NaxConfig["execution"]>) {
  return makeNaxConfig({ execution });
}

describe("resolvePermissions — unrestricted", () => {
  test("grants every default tool unconditionally", () => {
    const resolved = resolvePermissions(configWith({ permissionProfile: "unrestricted" }), "run");
    expect(resolved.mode).toBe("approve-all");
    const write = resolved.toolGrants?.find((g) => g.tool === "Write");
    expect(write?.patterns).toEqual(["*"]);
  });
});

describe("resolvePermissions — safe", () => {
  test("grants read tools only", () => {
    const resolved = resolvePermissions(configWith({ permissionProfile: "safe" }), "run");
    const names = (resolved.toolGrants ?? []).map((g) => g.tool).sort();
    expect(names).toEqual([...DEFAULT_CODING_TOOLS].sort());
  });

  test("does not grant Write", () => {
    const resolved = resolvePermissions(configWith({ permissionProfile: "safe" }), "run");
    expect((resolved.toolGrants ?? []).some((g) => g.tool === "Write")).toBe(false);
  });
});

describe("resolvePermissions — scoped", () => {
  const scoped = configWith({
    permissionProfile: "scoped",
    permissions: {
      default: { allowedTools: ["Read", "Glob", "Grep"] },
      run: { allowedTools: ["Read", "Write(src/**,test/**)"] },
      rectification: { inherit: "run" },
      review: { allowedTools: ["Read", "Git(diff,log)"] },
    },
  });

  test("parses a pattern list out of a tool expression", () => {
    const resolved = resolvePermissions(scoped, "run");
    const write = resolved.toolGrants?.find((g) => g.tool === "Write");
    expect(write?.patterns).toEqual(["src/**", "test/**"]);
  });

  test("a bare tool name grants it unconditionally", () => {
    const resolved = resolvePermissions(scoped, "run");
    expect(resolved.toolGrants?.find((g) => g.tool === "Read")?.patterns).toEqual(["*"]);
  });

  test("follows an inherit chain", () => {
    const resolved = resolvePermissions(scoped, "rectification");
    expect(resolved.toolGrants?.find((g) => g.tool === "Write")?.patterns).toEqual(["src/**", "test/**"]);
  });

  test("falls back to the default block for an unlisted stage", () => {
    const resolved = resolvePermissions(scoped, "acceptance");
    expect((resolved.toolGrants ?? []).map((g) => g.tool).sort()).toEqual(["Glob", "Grep", "Read"]);
  });

  test("carries subcommand patterns for a verb-gated tool", () => {
    const resolved = resolvePermissions(scoped, "review");
    expect(resolved.toolGrants?.find((g) => g.tool === "Git")?.patterns).toEqual(["diff", "log"]);
  });

  test("scoped with no permissions block grants nothing and stays read-only", () => {
    const resolved = resolvePermissions(configWith({ permissionProfile: "scoped" }), "run");
    expect(resolved.mode).toBe("approve-reads");
    expect(resolved.toolGrants).toEqual([]);
  });
});
