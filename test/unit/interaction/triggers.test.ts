/**
 * Unit tests for cost/merge trigger wiring (TC-001)
 * and US-004: agentGetFn passthrough to preRunCtx in unified-executor.
 *
 * Covers: checkCostExceeded abort/skip/continue, checkCostWarning at 80%/100%
 * threshold, and isTriggerEnabled guard (no interaction plugin = today behavior).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import { InteractionChain } from "../../../src/interaction/chain";
import type { InteractionPlugin, InteractionResponse } from "../../../src/interaction/types";
import { checkCostExceeded, checkCostWarning, checkPreMerge, isTriggerEnabled } from "../../../src/interaction/triggers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeChain(action: InteractionResponse["action"]): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "escalate" });
  const plugin: InteractionPlugin = {
    name: "test",
    send: mock(async () => {}),
    receive: mock(async (id: string): Promise<InteractionResponse> => ({
      requestId: id,
      action,
      respondedBy: "user",
      respondedAt: Date.now(),
    })),
  };
  chain.register(plugin);
  return chain;
}

function makeConfig(triggers: Record<string, unknown>): NaxConfig {
  return {
    interaction: {
      plugin: "cli",
      defaults: { timeout: 30000, fallback: "escalate" as const },
      triggers,
    },
  } as unknown as NaxConfig;
}

afterEach(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// isTriggerEnabled — no interaction plugin = today behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("isTriggerEnabled — no interaction plugin configured", () => {
  test("returns false when cost-exceeded is not in triggers", () => {
    const config = makeConfig({});
    expect(isTriggerEnabled("cost-exceeded", config)).toBe(false);
  });

  test("returns false when cost-warning is not in triggers", () => {
    const config = makeConfig({});
    expect(isTriggerEnabled("cost-warning", config)).toBe(false);
  });

  test("returns false when trigger explicitly disabled", () => {
    const config = makeConfig({ "cost-exceeded": { enabled: false } });
    expect(isTriggerEnabled("cost-exceeded", config)).toBe(false);
  });

  test("returns true when trigger is boolean true", () => {
    const config = makeConfig({ "cost-warning": true });
    expect(isTriggerEnabled("cost-warning", config)).toBe(true);
  });

  test("returns true when trigger is enabled:true object", () => {
    const config = makeConfig({ "cost-exceeded": { enabled: true } });
    expect(isTriggerEnabled("cost-exceeded", config)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkCostExceeded — 100% threshold responses
// ─────────────────────────────────────────────────────────────────────────────

describe("checkCostExceeded — abort response exits with cost-limit", () => {
  const context = { featureName: "feature-x", cost: 1.0, limit: 1.0 };

  test("returns false when trigger responds abort", async () => {
    const config = makeConfig({ "cost-exceeded": { enabled: true } });
    const chain = makeChain("abort");
    const result = await checkCostExceeded(context, config, chain);
    expect(result).toBe(false);
  });

  test("returns true (proceed past limit) when trigger responds skip", async () => {
    const config = makeConfig({ "cost-exceeded": { enabled: true } });
    const chain = makeChain("skip");
    const result = await checkCostExceeded(context, config, chain);
    expect(result).toBe(true);
  });

  test("returns true (proceed past limit) when trigger responds approve/continue", async () => {
    const config = makeConfig({ "cost-exceeded": { enabled: true } });
    const chain = makeChain("approve");
    const result = await checkCostExceeded(context, config, chain);
    expect(result).toBe(true);
  });

  test("returns true without prompting when trigger is disabled (today behavior preserved)", async () => {
    const config = makeConfig({});
    const chain = makeChain("abort");
    const result = await checkCostExceeded(context, config, chain);
    // Trigger disabled: checkCostExceeded returns true (caller decides to exit)
    expect(result).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004: agentGetFn passed to preRunCtx (structural verification)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: unified-executor passes agentGetFn to preRunCtx", () => {
  test("unified-executor.ts source includes agentGetFn: ctx.agentGetFn in preRunCtx", async () => {
    // Structural test: verify the source file wires agentGetFn into preRunCtx.
    // This prevents regressions where agentGetFn is removed from the context build.
    const source = await Bun.file(
      new URL("../../../src/execution/unified-executor.ts", import.meta.url).pathname,
    ).text();
    expect(source).toContain("agentGetFn: ctx.agentGetFn");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkCostWarning — 80% threshold
// ─────────────────────────────────────────────────────────────────────────────

describe("checkCostWarning — 80% threshold", () => {
  const context = { featureName: "feature-x", cost: 0.8, limit: 1.0 };

  test("returns 'escalate' when trigger responds approve", async () => {
    const config = makeConfig({ "cost-warning": { enabled: true } });
    const chain = makeChain("approve");
    const result = await checkCostWarning(context, config, chain);
    expect(result).toBe("escalate");
  });

  test("returns 'continue' when trigger responds skip", async () => {
    const config = makeConfig({ "cost-warning": { enabled: true } });
    const chain = makeChain("skip");
    const result = await checkCostWarning(context, config, chain);
    expect(result).toBe("continue");
  });

  test("returns 'continue' when trigger responds abort", async () => {
    const config = makeConfig({ "cost-warning": { enabled: true } });
    const chain = makeChain("abort");
    const result = await checkCostWarning(context, config, chain);
    expect(result).toBe("continue");
  });

  test("returns 'continue' without prompting when trigger is disabled", async () => {
    const config = makeConfig({});
    const chain = makeChain("approve");
    const result = await checkCostWarning(context, config, chain);
    expect(result).toBe("continue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Threshold guard logic (mirrors executor warningSent guard)
// ─────────────────────────────────────────────────────────────────────────────

describe("cost-warning threshold guard logic", () => {
  function shouldFireWarning(
    totalCost: number,
    costLimit: number,
    triggerCfg: boolean | { enabled: boolean; threshold?: number } | undefined,
    warningSent: boolean,
  ): boolean {
    if (warningSent) return false;
    const threshold = typeof triggerCfg === "object" ? (triggerCfg.threshold ?? 0.8) : 0.8;
    return totalCost >= costLimit * threshold;
  }

  test("does not fire when cost is below 80% of limit", () => {
    expect(shouldFireWarning(7.9, 10, { enabled: true }, false)).toBe(false);
  });

  test("fires when cost is exactly at 80% of limit", () => {
    expect(shouldFireWarning(8.0, 10, { enabled: true }, false)).toBe(true);
  });

  test("fires when cost is between 80% and 100% of limit", () => {
    expect(shouldFireWarning(9.5, 10, { enabled: true }, false)).toBe(true);
  });

  test("fires when cost is at 100% of limit", () => {
    expect(shouldFireWarning(10.0, 10, { enabled: true }, false)).toBe(true);
  });

  test("does not fire a second time if warningSent is true", () => {
    expect(shouldFireWarning(9.0, 10, { enabled: true }, true)).toBe(false);
  });

  test("uses custom threshold when provided in trigger config", () => {
    // threshold: 0.9 means fires at 90% not 80%
    expect(shouldFireWarning(8.5, 10, { enabled: true, threshold: 0.9 }, false)).toBe(false);
    expect(shouldFireWarning(9.0, 10, { enabled: true, threshold: 0.9 }, false)).toBe(true);
  });

  test("defaults to 0.8 when trigger config is a boolean", () => {
    expect(shouldFireWarning(7.9, 10, true, false)).toBe(false);
    expect(shouldFireWarning(8.0, 10, true, false)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkPreMerge — pre-merge trigger before run:completed
// ─────────────────────────────────────────────────────────────────────────────

describe("checkPreMerge — approve/abort responses", () => {
  const context = { featureName: "feature-x", totalStories: 3, cost: 0.5 };

  test("returns false when trigger responds abort", async () => {
    const config = makeConfig({ "pre-merge": { enabled: true } });
    const chain = makeChain("abort");
    const result = await checkPreMerge(context, config, chain);
    expect(result).toBe(false);
  });

  test("returns true when trigger responds approve", async () => {
    const config = makeConfig({ "pre-merge": { enabled: true } });
    const chain = makeChain("approve");
    const result = await checkPreMerge(context, config, chain);
    expect(result).toBe(true);
  });

  test("returns false when trigger responds skip (non-approve = abort run)", async () => {
    const config = makeConfig({ "pre-merge": { enabled: true } });
    const chain = makeChain("skip");
    const result = await checkPreMerge(context, config, chain);
    expect(result).toBe(false);
  });

  test("returns true without prompting when trigger is disabled", async () => {
    const config = makeConfig({});
    const chain = makeChain("abort");
    const result = await checkPreMerge(context, config, chain);
    // Trigger disabled: checkPreMerge returns true (proceed normally)
    expect(result).toBe(true);
  });
});
