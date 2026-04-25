/**
 * Unit tests for src/config/permissions.ts
 *
 * Covers:
 * - resolvePermissions() for all 3 profiles × representative stages
 * - Default behaviour when no config / no permissionProfile is provided
 * - "scoped" profile returns safe defaults (Phase 2 stub)
 * - No dangerouslySkipPermissions references remain in src/ (grep check)
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
// Default behaviour (no permissionProfile set)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePermissions — default behaviour", () => {
  test("no permissionProfile → unrestricted (approve-all)", () => {
    const config = makeConfig();
    const result = resolvePermissions(config, "run");
    expect(result.mode).toBe("approve-all");
    expect(result.skipPermissions).toBe(true);
  });

  test("no config → unrestricted (approve-all)", () => {
    const result = resolvePermissions(undefined, "run");
    expect(result.mode).toBe("approve-all");
    expect(result.skipPermissions).toBe(true);
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
