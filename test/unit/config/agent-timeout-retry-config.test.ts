/**
 * US-002 — config schema defaults for fail-timeout retry.
 *
 * AC6: `agent.timeoutRetry.maxAttempts` defaults to 1.
 * AC7: `agent.timeoutRetry.budgetMultiplier` defaults to 0.5.
 *
 * Boundary: the schema also accepts explicit override values and rejects
 * out-of-range inputs (negative maxAttempts, multiplier outside [0, 1]).
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";

describe("AC6 — agent.timeoutRetry.maxAttempts default is 1", () => {
  test("NaxConfigSchema.parse({}) resolves agent.timeoutRetry.maxAttempts to 1", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.timeoutRetry?.maxAttempts).toBe(1);
  });

  test("boundary: explicit maxAttempts overrides the default", () => {
    const result = NaxConfigSchema.parse({
      agent: { timeoutRetry: { maxAttempts: 3 } },
    });
    expect(result.agent?.timeoutRetry?.maxAttempts).toBe(3);
  });

  test("boundary: maxAttempts=0 is accepted (disables retry) and matches AC8", () => {
    // AC8 verifies runtime behavior — here we confirm the schema permits it.
    const result = NaxConfigSchema.parse({
      agent: { timeoutRetry: { maxAttempts: 0 } },
    });
    expect(result.agent?.timeoutRetry?.maxAttempts).toBe(0);
  });

  test("boundary: schema rejects negative maxAttempts", () => {
    expect(() => NaxConfigSchema.parse({ agent: { timeoutRetry: { maxAttempts: -1 } } })).toThrow();
  });
});

describe("AC7 — agent.timeoutRetry.budgetMultiplier default is 0.5", () => {
  test("NaxConfigSchema.parse({}) resolves agent.timeoutRetry.budgetMultiplier to 0.5", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.agent?.timeoutRetry?.budgetMultiplier).toBe(0.5);
  });

  test("boundary: explicit budgetMultiplier overrides the default", () => {
    const result = NaxConfigSchema.parse({
      agent: { timeoutRetry: { budgetMultiplier: 0.25 } },
    });
    expect(result.agent?.timeoutRetry?.budgetMultiplier).toBe(0.25);
  });

  test("boundary: budgetMultiplier=0 is accepted (no time on retry)", () => {
    const result = NaxConfigSchema.parse({
      agent: { timeoutRetry: { budgetMultiplier: 0 } },
    });
    expect(result.agent?.timeoutRetry?.budgetMultiplier).toBe(0);
  });

  test("boundary: schema rejects budgetMultiplier outside [0, 1]", () => {
    expect(() => NaxConfigSchema.parse({ agent: { timeoutRetry: { budgetMultiplier: -0.1 } } })).toThrow();
    expect(() => NaxConfigSchema.parse({ agent: { timeoutRetry: { budgetMultiplier: 1.5 } } })).toThrow();
  });
});
