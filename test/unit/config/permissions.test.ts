/**
 * Unit tests for src/config/permissions.ts
 *
 * Covers:
 * - resolvePermissions() for all 3 profiles × representative stages
 * - Backward compat: dangerouslySkipPermissions: true → same as permissionProfile: "unrestricted"
 * - Precedence: permissionProfile overrides dangerouslySkipPermissions
 * - "scoped" profile returns safe defaults (Phase 2 stub)
 * - No local fallbacks remain in src/ (grep check)
 */

import { describe, expect, test } from "bun:test";
import { resolvePermissions } from "../../../src/config/permissions";
import type { PipelineStage } from "../../../src/config/permissions";
import type { NaxConfig } from "../../../src/config";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<NaxConfig["execution"]> = {}): NaxConfig {
  return {
    execution: {
      maxIterations: 5,
      iterationDelayMs: 0,
      costLimit: 10,
      sessionTimeoutSeconds: 300,
      maxStoriesPerFeature: 10,
      rectification: { enabled: false, maxRetries: 0, fullSuiteTimeoutSeconds: 60, maxFailureSummaryChars: 500, abortOnIncreasingFailures: false },
      regressionGate: { enabled: false, timeoutSeconds: 60, acceptOnTimeout: true, mode: "disabled", maxRectificationAttempts: 1 },
      contextProviderTokenBudget: 2000,
      verificationTimeoutSeconds: 300,
      dangerouslySkipPermissions: false,
      ...overrides,
    },
  } as NaxConfig;
}

const REPRESENTATIVE_STAGES: PipelineStage[] = ["plan", "run", "rectification", "complete"];

// ─────────────────────────────────────────────────────────────────────────────
// Profile: unrestricted
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — unrestricted profile", () => {
  const config = makeConfig({ permissionProfile: "unrestricted" });

  test.each(REPRESENTATIVE_STAGES)("stage=%s → approve-all + skipPermissions=true", (stage) => {
    const result = resolvePermissions(config, stage);
    expect(result.mode).toBe("approve-all");
    expect(result.skipPermissions).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile: safe
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — safe profile", () => {
  const config = makeConfig({ permissionProfile: "safe" });

  test.each(REPRESENTATIVE_STAGES)("stage=%s → approve-reads + skipPermissions=false", (stage) => {
    const result = resolvePermissions(config, stage);
    expect(result.mode).toBe("approve-reads");
    expect(result.skipPermissions).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile: scoped (Phase 2 stub — safe defaults)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — scoped profile (Phase 2 stub)", () => {
  const config = makeConfig({ permissionProfile: "scoped" });

  test.each(REPRESENTATIVE_STAGES)("stage=%s → safe defaults (approve-reads, skipPermissions=false)", (stage) => {
    const result = resolvePermissions(config, stage);
    expect(result.mode).toBe("approve-reads");
    expect(result.skipPermissions).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Backward compat: dangerouslySkipPermissions boolean
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — backward compat (dangerouslySkipPermissions boolean)", () => {
  test("dangerouslySkipPermissions: true → same as permissionProfile: unrestricted", () => {
    const legacyConfig = makeConfig({ dangerouslySkipPermissions: true });
    const profileConfig = makeConfig({ permissionProfile: "unrestricted" });

    const legacyResult = resolvePermissions(legacyConfig, "run");
    const profileResult = resolvePermissions(profileConfig, "run");

    expect(legacyResult.mode).toBe(profileResult.mode);
    expect(legacyResult.skipPermissions).toBe(profileResult.skipPermissions);
    expect(legacyResult.mode).toBe("approve-all");
    expect(legacyResult.skipPermissions).toBe(true);
  });

  test("dangerouslySkipPermissions: false → safe mode (approve-reads)", () => {
    const config = makeConfig({ dangerouslySkipPermissions: false });
    const result = resolvePermissions(config, "run");
    expect(result.mode).toBe("approve-reads");
    expect(result.skipPermissions).toBe(false);
  });

  test("no config → safe defaults", () => {
    const result = resolvePermissions(undefined, "run");
    expect(result.mode).toBe("approve-reads");
    expect(result.skipPermissions).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Precedence: permissionProfile overrides dangerouslySkipPermissions
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — precedence", () => {
  test("permissionProfile=safe overrides dangerouslySkipPermissions=true", () => {
    const config = makeConfig({
      permissionProfile: "safe",
      dangerouslySkipPermissions: true, // would be "unrestricted" without profile
    });
    const result = resolvePermissions(config, "run");
    expect(result.mode).toBe("approve-reads");
    expect(result.skipPermissions).toBe(false);
  });

  test("permissionProfile=unrestricted overrides dangerouslySkipPermissions=false", () => {
    const config = makeConfig({
      permissionProfile: "unrestricted",
      dangerouslySkipPermissions: false, // would be "safe" without profile
    });
    const result = resolvePermissions(config, "run");
    expect(result.mode).toBe("approve-all");
    expect(result.skipPermissions).toBe(true);
  });

  test("permissionProfile=scoped overrides dangerouslySkipPermissions=true → still safe", () => {
    const config = makeConfig({
      permissionProfile: "scoped",
      dangerouslySkipPermissions: true,
    });
    const result = resolvePermissions(config, "run");
    // Phase 2 stub always returns safe defaults
    expect(result.mode).toBe("approve-reads");
    expect(result.skipPermissions).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Grep verify: no local permission fallbacks remain in src/
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — no local fallbacks in src/", () => {
  test("no ?? true fallback for dangerouslySkipPermissions in src/", async () => {
    const result = Bun.spawnSync(["grep", "-rn", "dangerouslySkipPermissions.*?? true", "src/"], {
      cwd: new URL("../../../", import.meta.url).pathname,
    });
    const matches = result.stdout.toString().trim();
    expect(matches).toBe("");
  });

  test("no ?? false fallback for dangerouslySkipPermissions in src/", async () => {
    const result = Bun.spawnSync(["grep", "-rn", "dangerouslySkipPermissions.*?? false", "src/"], {
      cwd: new URL("../../../", import.meta.url).pathname,
    });
    const matches = result.stdout.toString().trim();
    expect(matches).toBe("");
  });
});
