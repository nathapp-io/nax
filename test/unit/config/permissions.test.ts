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
  // Literal pre-change baselines, hardcoded on purpose. Deriving these from
  // DEFAULT_CODING_TOOLS / BUILT_IN_EXEC_PATTERNS (or from a second
  // resolvePermissions call) would make this test track a drift in those
  // constants instead of catching it, which is exactly the regression gate the
  // reviewer asked for.
  const PRE_CHANGE_UNRESTRICTED_TOOL_GRANTS = [
    { tool: "Read", patterns: ["*"] },
    { tool: "Glob", patterns: ["*"] },
    { tool: "Grep", patterns: ["*"] },
    { tool: "Write", patterns: ["*"] },
    { tool: "Edit", patterns: ["*"] },
    { tool: "Delete", patterns: ["*"] },
    { tool: "Git", patterns: ["*"] },
    { tool: "GitCommit", patterns: ["*"] },
    { tool: "RunCommand", patterns: ["*"] },
    { tool: "RequestCapability", patterns: ["*"] },
    {
      tool: "Exec",
      patterns: [
        "bun install",
        "bun add*",
        "npm ci",
        "npm install*",
        "pnpm install*",
        "pnpm add*",
        "yarn install*",
        "yarn add*",
        "pip install*",
        "uv sync*",
        "uv add*",
        "go mod download",
        "go get*",
        "cargo fetch",
        "cargo add*",
      ],
    },
  ];

  const PRE_CHANGE_SAFE_TOOL_GRANTS = [
    { tool: "Read", patterns: ["*"] },
    { tool: "Glob", patterns: ["*"] },
    { tool: "Grep", patterns: ["*"] },
  ];

  test("unrestricted with no permissions block is byte-identical to today", () => {
    const resolved = resolvePermissions(cfg({ permissionProfile: "unrestricted" }), "run");
    expect(resolved.mode).toBe("approve-all");
    expect(resolved.denyRules).toBeUndefined();
    expect(resolved.askRules).toBeUndefined();
    expect(resolved.toolGrants).toEqual(PRE_CHANGE_UNRESTRICTED_TOOL_GRANTS);
  });

  test("safe with no permissions block is byte-identical to today", () => {
    const resolved = resolvePermissions(cfg({ permissionProfile: "safe" }), "run");
    expect(resolved.mode).toBe("approve-reads");
    expect(resolved.denyRules).toBeUndefined();
    expect(resolved.askRules).toBeUndefined();
    expect(resolved.toolGrants).toEqual(PRE_CHANGE_SAFE_TOOL_GRANTS);
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
  });

  test("safe profile: rules attach, baseline stays reads-only", () => {
    const resolved = resolvePermissions(
      cfg({ permissionProfile: "safe", permissions: { run: { deny: ["Read(.env*)"] } } }),
      "run",
    );
    expect(resolved.mode).toBe("approve-reads");
    expect(resolved.toolGrants?.map((g) => g.tool)).toEqual(["Read", "Glob", "Grep"]);
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
