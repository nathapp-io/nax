/**
 * US-004 — execution.rectification.storyScopedFixBudget config knob.
 *
 * Acceptance criteria covered here:
 *   AC 1 — defaults to true when the field is unset
 *   AC 2 — explicit override to false is preserved through resolution
 *   AC 3 — string values are rejected (no coercion)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { NaxConfigSchema } from "@/config";

function rectificationConfig(overrides: Record<string, unknown> | undefined) {
  const base = { ...(DEFAULT_CONFIG as Record<string, unknown>) };
  if (overrides !== undefined) {
    const execution = base.execution as Record<string, unknown>;
    base.execution = { ...execution, rectification: overrides };
  }
  return base;
}

describe("execution.rectification.storyScopedFixBudget (US-004)", () => {
  test("[US-004 AC 1] defaults to true when execution.rectification is unset", () => {
    const config = NaxConfigSchema.parse({});
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification["storyScopedFixBudget"]).toBe(true);
  });

  test("[US-004 AC 1] defaults to true when execution.rectification is set without storyScopedFixBudget", () => {
    const config = NaxConfigSchema.parse(rectificationConfig({ enabled: true }));
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification["storyScopedFixBudget"]).toBe(true);
  });

  test("[US-004 AC 2] explicit project override to false is preserved", () => {
    const config = NaxConfigSchema.parse(rectificationConfig({ storyScopedFixBudget: false }));
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification["storyScopedFixBudget"]).toBe(false);
  });

  test("[US-004 AC 3] string value 'yes' is rejected without coercion", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ storyScopedFixBudget: "yes" }));
    expect(result.success).toBe(false);
  });

  test("[US-004 AC 3] string value 'true' is rejected without coercion", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ storyScopedFixBudget: "true" }));
    expect(result.success).toBe(false);
  });

  test("[US-004 AC 3] numeric value 1 is rejected (only true/false accepted)", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ storyScopedFixBudget: 1 }));
    expect(result.success).toBe(false);
  });
});