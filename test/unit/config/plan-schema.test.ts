/**
 * Tests for PlanConfigSchema extensions — mode, citationThreshold, criticModel.
 * Covers AC1–AC7 of the config.plan.mode schema story.
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema, PlanConfigSchema } from "@/config";

describe("PlanConfigSchema — mode / citationThreshold / criticModel (AC1–AC7)", () => {
  // AC1: NaxConfigSchema.parse({}) yields correct defaults
  test("AC1: NaxConfigSchema defaults — mode undefined, citationThreshold 0.5, criticModel fast", () => {
    const cfg = NaxConfigSchema.parse({});
    expect(cfg.plan.mode).toBeUndefined();
    expect(cfg.plan.citationThreshold).toBe(0.5);
    expect(cfg.plan.criticModel).toBe("fast");
  });

  // AC2–AC4: valid mode values round-trip
  test.each([["single"], ["debate"], ["pipeline"]] as const)("AC2–4: mode=%s round-trips", (mode) => {
    const base = NaxConfigSchema.parse({}).plan;
    const result = PlanConfigSchema.parse({ ...base, mode });
    expect(result.mode).toBe(mode);
  });

  // AC5: unknown mode throws ZodError
  test("AC5: unknown mode throws ZodError", () => {
    const base = NaxConfigSchema.parse({}).plan;
    expect(() => PlanConfigSchema.parse({ ...base, mode: "unknown" })).toThrow();
  });

  // AC6: citationThreshold > 1 throws ZodError
  test("AC6: citationThreshold 1.5 throws ZodError", () => {
    const base = NaxConfigSchema.parse({}).plan;
    expect(() => PlanConfigSchema.parse({ ...base, citationThreshold: 1.5 })).toThrow();
  });

  // AC7: overrides are preserved
  test("AC7: citationThreshold and criticModel overrides are preserved", () => {
    const base = NaxConfigSchema.parse({}).plan;
    const result = PlanConfigSchema.parse({ ...base, citationThreshold: 0.7, criticModel: "balanced" });
    expect(result.citationThreshold).toBe(0.7);
    expect(result.criticModel).toBe("balanced");
  });
});
