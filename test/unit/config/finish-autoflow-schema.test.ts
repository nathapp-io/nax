import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";

describe("finish.autoFlow schema", () => {
  test("defaults: disabled, canonical flow path, telegram on", () => {
    const c = NaxConfigSchema.parse({ version: 1 });
    expect(c.finish.autoFlow.enabled).toBe(false);
    expect(c.finish.autoFlow.flowPath).toBe("flows/nax-finish/nax-finish.flow.ts");
    expect(c.finish.autoFlow.defaultAgent).toBeNull();
    expect(c.finish.autoFlow.reviewers).toEqual({ spec: null, quality: null });
    expect(c.finish.autoFlow.escalate.telegram).toBe(true);
    // Every subprocess the flow awaits is capped — nothing defaults to unbounded.
    expect(c.finish.autoFlow.timeouts.acceptanceMs).toBeGreaterThan(0);
    expect(c.finish.autoFlow.timeouts.gateMs).toBeGreaterThan(0);
    expect(c.finish.autoFlow.timeouts.flowMs).toBeGreaterThan(0);
  });

  test("accepts timeout overrides and rejects non-positive budgets", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: { autoFlow: { timeouts: { acceptanceMs: 1000, gateMs: 2000, flowMs: 3000 } } },
    });
    expect(c.finish.autoFlow.timeouts).toEqual({ acceptanceMs: 1000, gateMs: 2000, flowMs: 3000 });
    expect(NaxConfigSchema.safeParse({ version: 1, finish: { autoFlow: { timeouts: { gateMs: 0 } } } }).success).toBe(
      false,
    );
  });

  test("accepts overrides", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: { autoFlow: { enabled: true, reviewers: { spec: "adversarial", quality: "balanced" }, escalate: { telegram: false } } },
    });
    expect(c.finish.autoFlow.enabled).toBe(true);
    expect(c.finish.autoFlow.reviewers.spec).toBe("adversarial");
    expect(c.finish.autoFlow.escalate.telegram).toBe(false);
  });
});
