// RE-ARCH: keep
/**
 * RegressionGateConfigSchema — `mode` enum field.
 *
 * `maxRectificationAttempts` was removed when the regression cycle was
 * consolidated under `execution.rectification.maxAttemptsTotal` — see
 * rejectLegacyRectificationKeys in src/config/loader.ts for the migration guard.
 */

import { describe, test, expect } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

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

// ---------------------------------------------------------------------------
// mode field
// ---------------------------------------------------------------------------

describe("RegressionGateConfigSchema - mode field", () => {
  test("accepts mode: 'deferred'", () => {
    const raw = buildConfigWith({ ...BASE_REGRESSION_GATE, mode: "deferred" });
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      // Cast needed until schema is updated (mode not yet in inferred type)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.data.execution.regressionGate as any).mode).toBe("deferred");
    }
  });

  test("accepts mode: 'per-story'", () => {
    const raw = buildConfigWith({ ...BASE_REGRESSION_GATE, mode: "per-story" });
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.data.execution.regressionGate as any).mode).toBe("per-story");
    }
  });

  test("accepts mode: 'disabled'", () => {
    const raw = buildConfigWith({ ...BASE_REGRESSION_GATE, mode: "disabled" });
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.data.execution.regressionGate as any).mode).toBe("disabled");
    }
  });

  test("defaults mode to 'deferred' when field is omitted", () => {
    const raw = buildConfigWith(BASE_REGRESSION_GATE);
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result.data.execution.regressionGate as any).mode).toBe("deferred");
    }
  });

  test("rejects invalid mode value", () => {
    const raw = buildConfigWith({ ...BASE_REGRESSION_GATE, mode: "always" });
    const result = NaxConfigSchema.safeParse(raw);
    // Schema must reject unknown enum values (currently strips them → FAILS)
    expect(result.success).toBe(false);
  });

  test("rejects numeric mode value", () => {
    const raw = buildConfigWith({ ...BASE_REGRESSION_GATE, mode: 1 });
    const result = NaxConfigSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });
});

// maxRectificationAttempts field removed — regression cycle now shares
// execution.rectification.maxAttemptsTotal. See rejectLegacyRectificationKeys
// in src/config/loader.ts for the migration guard.
