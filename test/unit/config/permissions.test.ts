/**
 * Unit tests for src/config/permissions.ts
 *
 * Covers:
 * - resolvePermissions() for all 3 profiles × representative stages
 * - Default behaviour when no config / no permissionProfile is provided
 * - "scoped" profile returns safe defaults (Phase 2 stub)
 * - Unset profile resolves through DEFAULT_PERMISSION_PROFILE (ruled: approve-all)
 * - An invalid profile that bypassed schema validation fails closed to approve-reads
 * - SESSION_CLOSE_PERMISSION_MODE is the SSOT constant for the session-close path
 * - No dangerouslySkipPermissions references remain in src/ (grep check)
 */

import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { PipelineStage } from "@/config/permissions";
import { DEFAULT_PERMISSION_PROFILE, resolvePermissions, SESSION_CLOSE_PERMISSION_MODE } from "@/config/permissions";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `rawProfile` injects a profile the `PermissionProfile` union does not contain —
 * the only way to reach `resolvePermissions`'s `default:` arm, which models a
 * config that bypassed schema validation. It rides the cast this helper already
 * makes rather than adding a second one at the call site.
 */
function makeConfig(overrides: Partial<NaxConfig["execution"]> = {}, rawProfile?: string): NaxConfig {
  return {
    execution: {
      maxIterations: 5,
      iterationDelayMs: 0,
      costLimit: 10,
      sessionTimeoutSeconds: 300,
      maxStoriesPerFeature: 10,
      rectification: {
        enabled: false,
        maxAttemptsTotal: 0,
        fullSuiteTimeoutSeconds: 60,
        maxFailureSummaryChars: 500,
        abortOnIncreasingFailures: false,
      },
      regressionGate: { enabled: false, timeoutSeconds: 60, acceptOnTimeout: true, mode: "disabled" },
      contextProviderTokenBudget: 2000,
      verificationTimeoutSeconds: 300,
      ...overrides,
      ...(rawProfile === undefined ? {} : { permissionProfile: rawProfile }),
    },
  } as NaxConfig;
}

const REPRESENTATIVE_STAGES: PipelineStage[] = ["plan", "run", "rectification", "complete"];

// ─────────────────────────────────────────────────────────────────────────────
// Profile: unrestricted
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — unrestricted profile", () => {
  const config = makeConfig({ permissionProfile: "unrestricted" });

  test.each(REPRESENTATIVE_STAGES)("stage=%s → approve-all", (stage) => {
    const result = resolvePermissions(config, stage);
    expect(result.mode).toBe("approve-all");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile: safe
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — safe profile", () => {
  const config = makeConfig({ permissionProfile: "safe" });

  test.each(REPRESENTATIVE_STAGES)("stage=%s → approve-reads", (stage) => {
    const result = resolvePermissions(config, stage);
    expect(result.mode).toBe("approve-reads");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile: scoped (Phase 2 stub — safe defaults)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — scoped profile (Phase 2 stub)", () => {
  const config = makeConfig({ permissionProfile: "scoped" });

  test.each(REPRESENTATIVE_STAGES)("stage=%s → safe defaults (approve-reads)", (stage) => {
    const result = resolvePermissions(config, stage);
    expect(result.mode).toBe("approve-reads");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Default behaviour (no permissionProfile set)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — default behaviour", () => {
  test("no permissionProfile → unrestricted (approve-all)", () => {
    const config = makeConfig();
    const result = resolvePermissions(config, "run");
    expect(result.mode).toBe("approve-all");
  });

  test("no config → unrestricted (approve-all)", () => {
    const result = resolvePermissions(undefined, "run");
    expect(result.mode).toBe("approve-all");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ENH-45: the two dispositions are distinct and each is named
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — unset vs invalid profile (ENH-45)", () => {
  test("DEFAULT_PERMISSION_PROFILE is unrestricted — the ruled disposition for unset", () => {
    expect(DEFAULT_PERMISSION_PROFILE).toBe("unrestricted");
  });

  test("unset profile resolves through DEFAULT_PERMISSION_PROFILE, not the invalid-value arm", () => {
    const viaUnset = resolvePermissions(makeConfig(), "run");
    const viaExplicit = resolvePermissions(makeConfig({ permissionProfile: DEFAULT_PERMISSION_PROFILE }), "run");
    expect(viaUnset.mode).toBe(viaExplicit.mode);
    expect(viaUnset.mode).toBe("approve-all");
  });

  test.each(REPRESENTATIVE_STAGES)("an invalid profile fails closed to approve-reads (stage=%s)", (stage) => {
    // A value the schema rejects; reachable only if config load was bypassed.
    const config = makeConfig({}, "wide-open");
    expect(resolvePermissions(config, stage).mode).toBe("approve-reads");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-12: the session-close path reads a named constant, not a literal
// ─────────────────────────────────────────────────────────────────────────────

describe("SESSION_CLOSE_PERMISSION_MODE (SEC-12)", () => {
  test("is approve-reads — the close path never runs agent work", () => {
    expect(SESSION_CLOSE_PERMISSION_MODE).toBe("approve-reads");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grep verify: dangerouslySkipPermissions fully removed from src/
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — dangerouslySkipPermissions absent from src/", () => {
  test("no dangerouslySkipPermissions references remain in src/", async () => {
    const result = Bun.spawnSync(["grep", "-rn", "dangerouslySkipPermissions", "src/"], {
      cwd: new URL("../../../", import.meta.url).pathname,
    });
    const matches = result.stdout.toString().trim();
    expect(matches).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule lists under every profile (spec R10)
// ─────────────────────────────────────────────────────────────────────────────

// NEVER a double cast through `unknown` — the check:test-as-unknown-as ratchet
// fails CI on any new occurrence. Mirror test/unit/config/scoped-permissions
// .test.ts:6-9's sanctioned idiom: makeNaxConfig(...) from @test/helpers takes
// a DeepPartial.
const cfg = (execution: Record<string, unknown>) => makeNaxConfig({ execution });

describe("resolvePermissions — rules under every profile (spec R10)", () => {
  test("unrestricted with no permissions block: scratchpad tools are among the granted names", () => {
    // US-003 AC3: when unrestricted permissions resolve, then grant names
    // include ScratchpadWrite, ScratchpadRead, and ScratchpadList. The
    // closed-world list-form is replaced by an invariant because the scratchpad
    // tools are now part of the baseline; the assertion pins WHAT was added,
    // not the entire ordering of the existing grants.
    const resolved = resolvePermissions(cfg({ permissionProfile: "unrestricted" }), "run");
    expect(resolved.mode).toBe("approve-all");
    expect(resolved.denyRules).toBeUndefined();
    expect(resolved.askRules).toBeUndefined();
    const grantNames = (resolved.toolGrants ?? []).map((g) => g.tool);
    expect(grantNames).toContain("ScratchpadWrite");
    expect(grantNames).toContain("ScratchpadRead");
    expect(grantNames).toContain("ScratchpadList");
  });

  test("safe with no permissions block: scratchpad tools are in grants, no repository-mutating tool is", () => {
    // US-003 AC2: when safe permissions resolve, then grant names include all
    // three scratchpad tools and include none of Write, Edit, Delete,
    // GitCommit, RunCommand, or Exec. Replacing the pre-change exact-list
    // assertion with this invariant because the closed list was tracking the
    // surface in a way that the new feature necessarily breaks; the property
    // `safe` actually guarantees -- reads + scratchpad, no mutating tool --
    // is what the test pins.
    const resolved = resolvePermissions(cfg({ permissionProfile: "safe" }), "run");
    expect(resolved.mode).toBe("approve-reads");
    expect(resolved.denyRules).toBeUndefined();
    expect(resolved.askRules).toBeUndefined();
    const grantNames = (resolved.toolGrants ?? []).map((g) => g.tool);
    // The three read tools stay (sanity check on the safe baseline shape).
    expect(grantNames).toContain("Read");
    expect(grantNames).toContain("Glob");
    expect(grantNames).toContain("Grep");
    // The three scratchpad tools are added.
    expect(grantNames).toContain("ScratchpadWrite");
    expect(grantNames).toContain("ScratchpadRead");
    expect(grantNames).toContain("ScratchpadList");
    // No repository-mutating tool reaches the safe baseline.
    const MUTATING = ["Write", "Edit", "Delete", "GitCommit", "RunCommand", "Exec"] as const;
    for (const tool of MUTATING) {
      expect(grantNames).not.toContain(tool);
    }
  });

  test("deny and ask rules attach under unrestricted", () => {
    const resolved = resolvePermissions(
      cfg({
        permissionProfile: "unrestricted",
        permissions: { run: { deny: ["Delete"], ask: ["GitCommit"] } },
      }),
      "run",
    );
    expect(resolved.mode).toBe("approve-all");
    expect(resolved.denyRules).toEqual([{ tool: "Delete", patterns: ["*"] }]);
    expect(resolved.askRules).toEqual([{ tool: "GitCommit", patterns: ["*"] }]);
  });

  test("allow rules extend the unrestricted baseline (extra Exec patterns)", () => {
    const resolved = resolvePermissions(
      cfg({
        permissionProfile: "unrestricted",
        permissions: { run: { allow: ["Exec(bun x tsc*)"] } },
      }),
      "run",
    );
    expect(resolved.toolGrants).toContainEqual({ tool: "Exec", patterns: ["bun x tsc*"] });
    // Baseline grants for OTHER tools stay. (At resolve level both Exec grants
    // are present; at compile level last-write-wins means the allow rule
    // replaces Exec's baseline patterns — see the Semantics block and Task 7.)
    expect(resolved.toolGrants?.some((g) => g.tool === "Read" && g.patterns.includes("*"))).toBe(true);
    // US-003 AC3 (boundary): adding an allow rule does not erase the scratchpad
    // tools from the baseline. Without the invariant a future refactor that
    // re-builds grants from `allow` only would silently drop them.
    const names = (resolved.toolGrants ?? []).map((g) => g.tool);
    expect(names).toContain("ScratchpadWrite");
    expect(names).toContain("ScratchpadRead");
    expect(names).toContain("ScratchpadList");
  });

  test("safe profile: rules attach, baseline keeps reads and scratchpad, no mutating tool", () => {
    const resolved = resolvePermissions(
      cfg({ permissionProfile: "safe", permissions: { run: { deny: ["Read(.env*)"] } } }),
      "run",
    );
    expect(resolved.mode).toBe("approve-reads");
    // Reads and scratchpads stay, no Write/Edit/Delete/GitCommit/RunCommand/Exec.
    const names = (resolved.toolGrants ?? []).map((g) => g.tool);
    expect(names).toContain("Read");
    expect(names).toContain("Glob");
    expect(names).toContain("Grep");
    expect(names).toContain("ScratchpadWrite");
    expect(names).toContain("ScratchpadRead");
    expect(names).toContain("ScratchpadList");
    expect(names).not.toContain("Write");
    expect(names).not.toContain("Edit");
    expect(names).not.toContain("Delete");
    expect(names).not.toContain("GitCommit");
    expect(names).not.toContain("RunCommand");
    expect(names).not.toContain("Exec");
    expect(resolved.denyRules).toEqual([{ tool: "Read", patterns: [".env*"] }]);
  });

  test("scoped: allow is an alias-compatible replacement for allowedTools", () => {
    const viaAlias = resolvePermissions(
      cfg({ permissionProfile: "scoped", permissions: { run: { allowedTools: ["Read", "Write(src/**)"] } } }),
      "run",
    );
    const viaAllow = resolvePermissions(
      cfg({ permissionProfile: "scoped", permissions: { run: { allow: ["Read", "Write(src/**)"] } } }),
      "run",
    );
    expect(viaAllow).toEqual(viaAlias);
  });

  test("inherit carries all three lists", () => {
    const resolved = resolvePermissions(
      cfg({
        permissionProfile: "scoped",
        permissions: {
          run: { allow: ["Read"], deny: ["Delete"], ask: ["GitCommit"] },
          verify: { inherit: "run" },
        },
      }),
      "verify",
    );
    expect(resolved.toolGrants).toEqual([{ tool: "Read", patterns: ["*"] }]);
    expect(resolved.denyRules).toEqual([{ tool: "Delete", patterns: ["*"] }]);
    expect(resolved.askRules).toEqual([{ tool: "GitCommit", patterns: ["*"] }]);
  });

  test("scoped with no block for the stage and no default: no grants, no rules", () => {
    const resolved = resolvePermissions(
      cfg({ permissionProfile: "scoped", permissions: { plan: { allow: ["Read"] } } }),
      "run",
    );
    expect(resolved).toEqual({ mode: "approve-reads", providerScope: "rules", toolGrants: [] });
  });
});

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
