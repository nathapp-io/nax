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
    expect(c.finish.autoFlow.notify.mode).toBe("escalation");
    // Every subprocess the flow awaits is capped — nothing defaults to unbounded.
    expect(c.finish.autoFlow.timeouts.acceptanceMs).toBeGreaterThan(0);
    expect(c.finish.autoFlow.timeouts.gateMs).toBeGreaterThan(0);
    expect(c.finish.autoFlow.timeouts.flowMs).toBeGreaterThan(0);
  });

  test("accepts timeout overrides and rejects non-positive budgets", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: { autoFlow: { timeouts: { acceptanceMs: 1000, gateMs: 2000, flowMs: 3000, stepMs: 4000 } } },
    });
    expect(c.finish.autoFlow.timeouts).toEqual({
      acceptanceMs: 1000,
      gateMs: 2000,
      flowMs: 3000,
      stepMs: 4000,
    });
    // stepMs is nullable — null means "leave acpx's own step default alone"
    expect(NaxConfigSchema.parse({ version: 1 }).finish.autoFlow.timeouts.stepMs).toBeNull();
    expect(NaxConfigSchema.safeParse({ version: 1, finish: { autoFlow: { timeouts: { gateMs: 0 } } } }).success).toBe(
      false,
    );
  });

  test("accepts overrides", () => {
    const c = NaxConfigSchema.parse({
      version: 1,
      finish: {
        autoFlow: {
          enabled: true,
          reviewers: { spec: "adversarial", quality: "balanced" },
          escalate: { telegram: false },
          notify: { mode: "always" },
        },
      },
    });
    expect(c.finish.autoFlow.enabled).toBe(true);
    expect(c.finish.autoFlow.reviewers.spec).toBe("adversarial");
    expect(c.finish.autoFlow.escalate.telegram).toBe(false);
    expect(c.finish.autoFlow.notify.mode).toBe("always");
    expect(
      NaxConfigSchema.safeParse({ version: 1, finish: { autoFlow: { notify: { mode: "sometimes" } } } }).success,
    ).toBe(false);
  });
});

describe("finish.autoFlow.model", () => {
  // Opt-in, because it is only meaningful on an acpx build that supports a
  // `model` on agent entries — without that, `--model` has nothing above it in
  // the precedence chain and would override the pinned reviewers too.
  test("defaults to null so no --model is passed at all", () => {
    expect(NaxConfigSchema.parse({ version: 1 }).finish.autoFlow.model).toBeNull();
  });

  test("accepts a model id", () => {
    const c = NaxConfigSchema.parse({ version: 1, finish: { autoFlow: { model: "sonnet" } } });
    expect(c.finish.autoFlow.model).toBe("sonnet");
  });

  test("rejects an empty model id, which would produce a bare --model flag", () => {
    expect(NaxConfigSchema.safeParse({ version: 1, finish: { autoFlow: { model: "" } } }).success).toBe(false);
  });
});
