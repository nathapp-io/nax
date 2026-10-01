import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "@/config";

describe("finish schema", () => {
  test("defaults: disabled, telegram on", () => {
    const c = NaxConfigSchema.parse({ version: 1 });
    expect(c.finish.enabled).toBe(false);
    expect(c.finish.reviewers).toEqual({ spec: null, quality: null, narrative: null, fix: null });
    expect(c.finish.escalate.telegram).toBe(true);
    expect(c.finish.notify.mode).toBe("escalation");
    // Every stage the phase awaits is capped — nothing defaults to unbounded.
    expect(c.finish.timeouts.acceptanceMs).toBeGreaterThan(0);
    expect(c.finish.timeouts.gateMs).toBeGreaterThan(0);
    expect(c.finish.timeouts.flowMs).toBeGreaterThan(0);
  });

  test("accepts timeout overrides and rejects non-positive budgets", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: { timeouts: { acceptanceMs: 1000, gateMs: 2000, flowMs: 3000, stepMs: 4000 } },
    });
    expect(c.finish.timeouts).toEqual({
      acceptanceMs: 1000,
      gateMs: 2000,
      flowMs: 3000,
      stepMs: 4000,
    });
    // stepMs is nullable — null means "leave callOp's own step default alone"
    expect(NaxConfigSchema.parse({ version: 1 }).finish.timeouts.stepMs).toBeNull();
    expect(NaxConfigSchema.safeParse({ version: 1, finish: { timeouts: { gateMs: 0 } } }).success).toBe(false);
  });

  test("accepts overrides", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: {
        enabled: true,
        reviewers: { spec: "adversarial", quality: "balanced" },
        escalate: { telegram: false },
        notify: { mode: "always" },
      },
    });
    expect(c.finish.enabled).toBe(true);
    expect(c.finish.reviewers.spec).toBe("adversarial");
    expect(c.finish.escalate.telegram).toBe(false);
    expect(c.finish.notify.mode).toBe("always");
    expect(NaxConfigSchema.safeParse({ version: 1, finish: { notify: { mode: "sometimes" } } }).success).toBe(false);
  });

  test("reviewers accepts a { agent, model } object, not only a tier string", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: { reviewers: { fix: { agent: "claude", model: "sonnet" } } },
    });
    expect(c.finish.reviewers.fix).toEqual({ agent: "claude", model: "sonnet" });
  });
});

describe("finish.narrative", () => {
  test("narrative defaults to true and reviewers.narrative to null", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.finish.narrative).toBe(true);
    expect(parsed.finish.reviewers.narrative).toBeNull();
  });

  test("narrative can be disabled and given a model", () => {
    const parsed = NaxConfigSchema.parse({
      finish: { narrative: false, reviewers: { narrative: "haiku" } },
    });
    expect(parsed.finish.narrative).toBe(false);
    expect(parsed.finish.reviewers.narrative).toBe("haiku");
  });

  test("the finish-level default literal carries the narrative keys too", () => {
    // The schema repeats its defaults at two levels; a config with no `finish`
    // block at all must still parse to the same shape as one with an empty block.
    const empty = NaxConfigSchema.parse({});
    const explicit = NaxConfigSchema.parse({ finish: {} });
    expect(empty.finish.narrative).toBe(explicit.finish.narrative);
    expect(empty.finish.reviewers).toEqual(explicit.finish.reviewers);
  });
});
