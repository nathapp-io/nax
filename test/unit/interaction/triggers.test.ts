/**
 * Unit tests for cost/merge trigger wiring (TC-001)
 * and US-004: agentGetFn passthrough to preRunCtx in unified-executor.
 *
 * Covers: checkCostExceeded abort/skip/continue, checkCostWarning at 80%/100%
 * threshold, and isTriggerEnabled guard (no interaction plugin = today behavior).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { InteractionChain } from "../../../src/interaction/chain";
import type { InteractionPlugin, InteractionResponse } from "../../../src/interaction/types";
import { checkCostExceeded, checkCostWarning, checkPreMerge, isTriggerEnabled } from "../../../src/interaction/triggers";
import { makeNaxConfig } from "../../helpers";

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

function makeConfig(triggers: Record<string, unknown>) {
  return makeNaxConfig({
    interaction: {
      plugin: "cli",
      defaults: { timeout: 30000, fallback: "escalate" as const },
      triggers,
    },
  });
}

afterEach(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// isTriggerEnabled — no interaction plugin = today behavior
// ─────────────────────────────────────────────────────────────────────────────

describe("isTriggerEnabled — no interaction plugin configured", () => {
  test("false when missing or disabled; true when boolean true or enabled:true", () => {
    expect(isTriggerEnabled("cost-exceeded", makeConfig({}))).toBe(false);
    expect(isTriggerEnabled("cost-warning", makeConfig({}))).toBe(false);
    expect(isTriggerEnabled("cost-exceeded", makeConfig({ "cost-exceeded": { enabled: false } }))).toBe(false);
    expect(isTriggerEnabled("cost-warning", makeConfig({ "cost-warning": true }))).toBe(true);
    expect(isTriggerEnabled("cost-exceeded", makeConfig({ "cost-exceeded": { enabled: true } }))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkCostExceeded — 100% threshold responses
// ─────────────────────────────────────────────────────────────────────────────

describe("checkCostExceeded — abort response exits with cost-limit", () => {
  const context = { featureName: "feature-x", cost: 1.0, limit: 1.0 };
  const cfg = makeConfig({ "cost-exceeded": { enabled: true } });

  test("false on abort; true on skip/approve; true without prompting when disabled", async () => {
    expect(await checkCostExceeded(context, cfg, makeChain("abort"))).toBe(false);
    expect(await checkCostExceeded(context, cfg, makeChain("skip"))).toBe(true);
    expect(await checkCostExceeded(context, cfg, makeChain("approve"))).toBe(true);
    expect(await checkCostExceeded(context, makeConfig({}), makeChain("abort"))).toBe(true);
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
  const cfg = makeConfig({ "cost-warning": { enabled: true } });

  test("escalate on approve; continue on skip/abort/disabled", async () => {
    expect(await checkCostWarning(context, cfg, makeChain("approve"))).toBe("escalate");
    expect(await checkCostWarning(context, cfg, makeChain("skip"))).toBe("continue");
    expect(await checkCostWarning(context, cfg, makeChain("abort"))).toBe("continue");
    expect(await checkCostWarning(context, makeConfig({}), makeChain("approve"))).toBe("continue");
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

  test("does not fire below threshold or when warningSent; fires at/above 80%; custom threshold; boolean default", () => {
    expect(shouldFireWarning(7.9, 10, { enabled: true }, false)).toBe(false);
    expect(shouldFireWarning(9.0, 10, { enabled: true }, true)).toBe(false);
    expect(shouldFireWarning(8.0, 10, { enabled: true }, false)).toBe(true);
    expect(shouldFireWarning(9.5, 10, { enabled: true }, false)).toBe(true);
    expect(shouldFireWarning(10.0, 10, { enabled: true }, false)).toBe(true);
    expect(shouldFireWarning(8.5, 10, { enabled: true, threshold: 0.9 }, false)).toBe(false);
    expect(shouldFireWarning(9.0, 10, { enabled: true, threshold: 0.9 }, false)).toBe(true);
    expect(shouldFireWarning(7.9, 10, true, false)).toBe(false);
    expect(shouldFireWarning(8.0, 10, true, false)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkPreMerge — pre-merge trigger before run:completed
// ─────────────────────────────────────────────────────────────────────────────

describe("checkPreMerge — approve/abort responses", () => {
  const context = { featureName: "feature-x", totalStories: 3, cost: 0.5 };
  const cfg = makeConfig({ "pre-merge": { enabled: true } });

  test("false on abort/skip; true on approve; true without prompting when disabled", async () => {
    expect(await checkPreMerge(context, cfg, makeChain("abort"))).toBe(false);
    expect(await checkPreMerge(context, cfg, makeChain("skip"))).toBe(false);
    expect(await checkPreMerge(context, cfg, makeChain("approve"))).toBe(true);
    expect(await checkPreMerge(context, makeConfig({}), makeChain("abort"))).toBe(true);
  });
});
