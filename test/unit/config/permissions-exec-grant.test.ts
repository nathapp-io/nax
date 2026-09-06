import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { resolvePermissions } from "@/config/permissions";

describe("Exec grant", () => {
  const baseConfig = makeNaxConfig({ execution: { permissionProfile: "unrestricted" } });

  test("unrestricted grants Exec the built-in install list, never a wildcard", () => {
    const resolved = resolvePermissions(baseConfig, "run");
    const execGrant = (resolved.toolGrants ?? []).find((g) => g.tool === "Exec");
    expect(execGrant).toBeDefined();
    // The whole point of the exclusion: unrestricted means "any tool, any path
    // within the root", and must never come to mean "any command".
    expect(execGrant?.patterns).not.toContain("*");
    expect(execGrant?.patterns).toContain("bun add*");
    expect(execGrant?.patterns).toContain("npm ci");
  });

  test("the built-in list holds install forms only", () => {
    const resolved = resolvePermissions(baseConfig, "run");
    const patterns = (resolved.toolGrants ?? []).find((g) => g.tool === "Exec")?.patterns ?? [];
    // A generic command is reachable only through a human-written grant.
    expect(patterns.some((p) => p.startsWith("make") || p.includes(" x "))).toBe(false);
  });

  test("unrestricted still grants the ordinary tools", () => {
    // Both halves non-empty: asserting only the Exec shape above would pass
    // trivially if grant resolution were broken end to end.
    const resolved = resolvePermissions(baseConfig, "run");
    const tools = (resolved.toolGrants ?? []).map((g) => g.tool);
    expect(tools).toContain("Write");
    expect(tools).toContain("RunCommand");
  });

  test("an explicit Exec expression parses into patterns", () => {
    // `permissions` (the #374 per-stage block that carries these expressions)
    // is typed on `ExecutionConfig` (src/config/runtime-types.ts), so a plain
    // `makeNaxConfig` override is enough — no cast needed. Mirrors the
    // `configWith` idiom in test/unit/config/scoped-permissions.test.ts.
    const config = makeNaxConfig({
      execution: {
        permissionProfile: "scoped",
        permissions: {
          default: { allowedTools: ["Exec(bun add*, bun install)", "Read"] },
        },
      },
    });
    const resolved = resolvePermissions(config, "run");
    const execGrant = (resolved.toolGrants ?? []).find((g) => g.tool === "Exec");
    expect(execGrant?.patterns).toEqual(["bun add*", "bun install"]);
  });
});
