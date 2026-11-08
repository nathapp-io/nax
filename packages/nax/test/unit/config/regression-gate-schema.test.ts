// RE-ARCH: keep
/**
 * RegressionGateConfigSchema — the live fields and their bounds.
 *
 * `maxRectificationAttempts` was removed when the regression cycle was
 * consolidated under `execution.rectification.maxAttemptsTotal` — see
 * rejectLegacyRectificationKeys in src/config/loader.ts for the migration guard.
 * `mode` was removed with the pipeline-mode removal (US-003): nothing read it,
 * and a config that still sets it is stripped with a warning by
 * src/config/removed-config-keys.ts.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { NaxConfigSchema } from "@/config/schemas";
import { DEFAULT_FULL_SUITE_TIMEOUT_SECONDS } from "@/quality";

// ---------------------------------------------------------------------------
// Helper: build a full NaxConfig-shaped object with a custom regressionGate
// ---------------------------------------------------------------------------

function buildConfigWith(regressionGate: Record<string, unknown>) {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      regressionGate,
    },
  };
}

const BASE_REGRESSION_GATE = {
  enabled: true,
  timeoutSeconds: 120,
  acceptOnTimeout: true,
};

// maxRectificationAttempts field removed — regression cycle now shares
// execution.rectification.maxAttemptsTotal. See rejectLegacyRectificationKeys
// in src/config/loader.ts for the migration guard.

// ---------------------------------------------------------------------------
// full-suite timeout range (#2536) — same ceiling as
// execution.rectification.fullSuiteTimeoutSeconds
// ---------------------------------------------------------------------------

describe("full-suite timeout range", () => {
  test.each([
    ["regressionGate.timeoutSeconds", (s: number) => buildConfigWith({ ...BASE_REGRESSION_GATE, timeoutSeconds: s })],
    [
      "rectification.fullSuiteTimeoutSeconds",
      (s: number) => ({
        ...DEFAULT_CONFIG,
        execution: {
          ...DEFAULT_CONFIG.execution,
          rectification: { ...DEFAULT_CONFIG.execution.rectification, fullSuiteTimeoutSeconds: s },
        },
      }),
    ],
  ])("%s accepts up to 3600 and rejects above", (_key, build) => {
    expect(NaxConfigSchema.safeParse(build(1800)).success).toBe(true);
    expect(NaxConfigSchema.safeParse(build(3600)).success).toBe(true);
    expect(NaxConfigSchema.safeParse(build(3601)).success).toBe(false);
  });
});

describe("full-suite timeout defaults (#2536)", () => {
  test("both keys default to 600s, so an untuned project's agent can run a suite slower than 120s", () => {
    expect(DEFAULT_CONFIG.execution.regressionGate.timeoutSeconds).toBe(600);
    expect(DEFAULT_CONFIG.execution.rectification.fullSuiteTimeoutSeconds).toBe(600);
    expect(DEFAULT_FULL_SUITE_TIMEOUT_SECONDS).toBe(600);
  });
});
