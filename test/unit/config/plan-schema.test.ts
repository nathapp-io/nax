/**
 * Tests for PlanConfigSchema — mode.
 * Covers the surviving plan.mode schema arms: "single" and "refine".
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema, PlanConfigSchema } from "@/config";

describe("PlanConfigSchema — mode", () => {
  // AC1: NaxConfigSchema.parse({}) yields correct defaults
  test("AC1: NaxConfigSchema defaults — mode undefined", () => {
    const cfg = NaxConfigSchema.parse({});
    expect(cfg.plan.mode).toBeUndefined();
  });

  // AC2–AC3: valid mode values round-trip
  test.each([["single"], ["refine"]] as const)("AC2–3: mode=%s round-trips", (mode) => {
    const base = NaxConfigSchema.parse({}).plan;
    const result = PlanConfigSchema.parse({ ...base, mode });
    expect(result.mode).toBe(mode);
  });

  // AC4: unknown mode throws ZodError
  test("AC4: unknown mode throws ZodError", () => {
    const base = NaxConfigSchema.parse({}).plan;
    expect(() => PlanConfigSchema.parse({ ...base, mode: "unknown" })).toThrow();
  });
});