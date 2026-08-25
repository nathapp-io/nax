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
import type { NaxConfig } from "@/config";
import type { PipelineStage } from "@/config/permissions";
import { resolvePermissions } from "@/config/permissions";

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
