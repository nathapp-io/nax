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
