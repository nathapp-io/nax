/**
 * Unit tests for cost/merge trigger wiring (TC-001)
 * and US-004: agentGetFn passthrough to preRunCtx in unified-executor.
 *
 * Covers: checkCostExceeded abort/skip/continue, checkCostWarning at 80%/100%
 * threshold, and isTriggerEnabled guard (no interaction plugin = today behavior).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeInteractionChain, makeNaxConfig } from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { InteractionConfig } from "@/config/runtime-types";
import { InteractionChain } from "@/interaction/chain";
import {
  checkCostExceeded,
  checkCostWarning,
  checkMaxRetries,
  checkMergeConflict,
  checkPreMerge,
  checkReviewGate,
  checkSecurityReview,
  createTriggerRequest,
  executeTrigger,
  getTriggerConfig,
  isTriggerEnabled,
  substituteTemplate,
  type TriggerContext,
} from "@/interaction/triggers";
import type { InteractionPlugin, InteractionResponse, TriggerName } from "@/interaction/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeChain(action: InteractionResponse["action"]): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "escalate" });
  const plugin: InteractionPlugin = {
    name: "test",
    send: mock(async () => {}),
    receive: mock(
      async (id: string): Promise<InteractionResponse> => ({
        requestId: id,
        action,
        respondedBy: "user",
        respondedAt: Date.now(),
      }),
    ),
  };
  chain.register(plugin);
  return chain;
}

/**
 * BUG-17: simulates a trigger that times out — respondedBy: "timeout" with
 * a plugin-supplied default action (typically "skip"). Distinct from
 * makeChain() (respondedBy: "user"), which is an explicit response and
 * bypasses the fallback entirely.
 */
function makeTimeoutChain(): InteractionChain {
  const chain = new InteractionChain({ defaultTimeout: 5000, defaultFallback: "escalate" });
  const plugin: InteractionPlugin = {
    name: "test",
    send: mock(async () => {}),
    receive: mock(
      async (id: string): Promise<InteractionResponse> => ({
        requestId: id,
        action: "skip",
        respondedBy: "timeout",
        respondedAt: Date.now(),
      }),
    ),
  };
  chain.register(plugin);
  return chain;
}

function makeConfig(triggers: InteractionConfig["triggers"]) {
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

// ─────────────────────────────────────────────────────────────────────────────
// BUG-17: every trigger honors its configured fallback on timeout, not just
// review-gate. Before the fix, checkCostExceeded/checkMergeConflict/
// checkSecurityReview compared response.action directly — a timeout response
// (action: "skip") always compared !== "abort" and proceeded, even when
// fallback: "abort" was configured. checkMaxRetries had the mirror bug
// (action: "skip" always meant "skip", ignoring a "continue" fallback).
// ─────────────────────────────────────────────────────────────────────────────

describe("BUG-17: trigger fallback honored on timeout for every trigger", () => {
  test("checkCostExceeded aborts on timeout when fallback is abort", async () => {
    const cfg = makeConfig({ "cost-exceeded": { enabled: true, fallback: "abort" } });
    const context = { featureName: "feature-x", cost: 1.0, limit: 1.0 };
    expect(await checkCostExceeded(context, cfg, makeTimeoutChain())).toBe(false);
  });

  test("checkCostExceeded proceeds on timeout when fallback is continue", async () => {
    const cfg = makeConfig({ "cost-exceeded": { enabled: true, fallback: "continue" } });
    const context = { featureName: "feature-x", cost: 1.0, limit: 1.0 };
    expect(await checkCostExceeded(context, cfg, makeTimeoutChain())).toBe(true);
  });

  test("checkMergeConflict aborts on timeout when fallback is abort", async () => {
    const cfg = makeConfig({ "merge-conflict": { enabled: true, fallback: "abort" } });
    const context = { featureName: "feature-x" };
    expect(await checkMergeConflict(context, cfg, makeTimeoutChain())).toBe(false);
  });

  test("checkSecurityReview aborts on timeout when fallback is abort", async () => {
    const cfg = makeConfig({ "security-review": { enabled: true, fallback: "abort" } });
    const context = { featureName: "feature-x" };
    expect(await checkSecurityReview(context, cfg, makeTimeoutChain())).toBe(false);
  });

  test("checkMaxRetries continues (not skip) on timeout when fallback is continue", async () => {
    const cfg = makeConfig({ "max-retries": { enabled: true, fallback: "continue" } });
    const context = { featureName: "feature-x" };
    // Timeout response action is "skip", but fallback: "continue" maps to
    // "approve" via applyFallback — the story must not be skipped.
    expect(await checkMaxRetries(context, cfg, makeTimeoutChain())).toBe("continue");
  });

  test("checkMaxRetries skips on timeout when fallback is skip", async () => {
    const cfg = makeConfig({ "max-retries": { enabled: true, fallback: "skip" } });
    const context = { featureName: "feature-x" };
    expect(await checkMaxRetries(context, cfg, makeTimeoutChain())).toBe("skip");
  });

  test("checkPreMerge does not approve on timeout when fallback is abort", async () => {
    const cfg = makeConfig({ "pre-merge": { enabled: true, fallback: "abort" } });
    const context = { featureName: "feature-x", totalStories: 1, cost: 0.1 };
    expect(await checkPreMerge(context, cfg, makeTimeoutChain())).toBe(false);
  });

  test("an explicit (non-timeout) user response is unaffected by fallback config", async () => {
    // Regression guard: applyFallback only kicks in for respondedBy timeout/system.
    const cfg = makeConfig({ "cost-exceeded": { enabled: true, fallback: "abort" } });
    const context = { featureName: "feature-x", cost: 1.0, limit: 1.0 };
    expect(await checkCostExceeded(context, cfg, makeChain("approve"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// substituteTemplate — context-key RegExp escaping (BUG-43)
// ─────────────────────────────────────────────────────────────────────────────

describe("substituteTemplate (BUG-43)", () => {
  test("substitutes a plain alphanumeric key", () => {
    expect(substituteTemplate("hello {{name}}", { name: "world", featureName: "f" })).toBe("hello world");
  });

  test("substitutes a key with regex metacharacters without throwing or mis-substituting", () => {
    // BUG-43 (D-27): the previous code interpolated the key directly into
    // a RegExp. A key like `cost(usd)` parses `(` as a regex group, which
    // either throws (unmatched group) or matches a different substring
    // than `{{cost(usd)}}`. TriggerContext has an open index signature
    // so callers can add arbitrary keys — escape the key before use.
    const template = "limit was {{cost(usd)}}";
    const result = substituteTemplate(template, { "cost(usd)": "$1.23", featureName: "f" });
    expect(result).toBe("limit was $1.23");
  });

  test("substitutes keys with braces, dots, slashes, and backslashes", () => {
    const template = "a {{a.b}} b {{c[0]}} c {{d/e}} d {{f\\g}}";
    const result = substituteTemplate(template, {
      "a.b": "A",
      "c[0]": "C",
      "d/e": "D",
      "f\\g": "F",
      featureName: "f",
    });
    expect(result).toBe("a A b C c D d F");
  });

  test("leaves a placeholder untouched when the key is not in context", () => {
    // Verifies the regex wasn't so over-escaped that legitimate keys
    // stop matching. Plain alphanumeric keys must still substitute.
    const result = substituteTemplate("hi {{name}}", { other: "x", featureName: "f" });
    expect(result).toBe("hi {{name}}");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Narrowed config (Pick<NaxConfig, 'interaction'>) — the trigger functions
// only ever read interaction.*, so they are exercised against a hand-sliced
// config rather than a full makeNaxConfig.
// ─────────────────────────────────────────────────────────────────────────────

const makeSlicedConfig = (
  triggers: Partial<Record<TriggerName, unknown>>,
  defaults: Record<string, unknown> = {},
): NaxConfig => ({ interaction: { triggers: triggers as Record<string, unknown>, defaults } }) as NaxConfig;

const mockChain = makeInteractionChain();

describe("triggers — narrowed config (Pick<NaxConfig, 'interaction'>)", () => {
  describe("isTriggerEnabled", () => {
    test("false when not configured or disabled; true when boolean true or {enabled:true}", () => {
      expect(isTriggerEnabled("security-review", makeSlicedConfig({}))).toBe(false);
      expect(isTriggerEnabled("security-review", makeSlicedConfig({ "security-review": true }))).toBe(true);
      expect(isTriggerEnabled("security-review", makeSlicedConfig({ "security-review": { enabled: true } }))).toBe(
        true,
      );
      expect(isTriggerEnabled("security-review", makeSlicedConfig({ "security-review": { enabled: false } }))).toBe(
        false,
      );
    });
  });

  describe("getTriggerConfig", () => {
    test("returns defaults (with metadata fallback) when not configured; overrides when configured", () => {
      const r1 = getTriggerConfig("security-review", makeSlicedConfig({}, { timeout: 30000, fallback: "approve" }));
      expect(r1.timeout).toBe(30000);
      expect(r1.fallback).toBe("abort");
      const r2 = getTriggerConfig(
        "security-review",
        makeSlicedConfig(
          { "security-review": { timeout: 60000, fallback: "escalate" } },
          { timeout: 30000, fallback: "approve" },
        ),
      );
      expect(r2.timeout).toBe(60000);
      expect(r2.fallback).toBe("escalate");
    });

    // BUG-48 (D-9): interaction.defaults.fallback is the documented migration
    // path for the removed "auto" plugin — it must actually take effect for
    // non-red triggers, and must never override a red-tier gate's abort.
    test("honours interaction.defaults.fallback for a non-red trigger", () => {
      const r = getTriggerConfig("cost-warning", makeSlicedConfig({}, { fallback: "abort" }));
      expect(r.fallback).toBe("abort");
    });

    test("red-tier gate ignores a global fallback:continue and keeps its metadata abort", () => {
      const r = getTriggerConfig("security-review", makeSlicedConfig({}, { fallback: "continue" }));
      expect(r.fallback).toBe("abort");
    });

    // The schema no longer bakes a default into interaction.defaults.fallback
    // (a schema-level default would be indistinguishable from an explicit
    // operator choice and silently override every trigger's own metadata
    // default). An unconfigured non-red trigger must keep its own default.
    test("unconfigured non-red trigger keeps its own metadata default, not a baked-in global default", () => {
      const maxRetries = getTriggerConfig("max-retries", makeSlicedConfig({}, {}));
      expect(maxRetries.fallback).toBe("skip");
      const reviewGate = getTriggerConfig("review-gate", makeSlicedConfig({}, {}));
      expect(reviewGate.fallback).toBe("continue");
    });
  });

  describe("createTriggerRequest", () => {
    test("correct id prefix + type; uses defaults when not configured", () => {
      const ctx: TriggerContext = { featureName: "my-feature" };
      const r1 = createTriggerRequest("security-review", ctx, makeSlicedConfig({}));
      expect(r1.id.startsWith("trigger-security-review-")).toBe(true);
      expect(r1.type).toBe("confirm");
      const r2 = createTriggerRequest(
        "security-review",
        ctx,
        makeSlicedConfig({}, { timeout: 60000, fallback: "escalate" }),
      );
      expect(r2.timeout).toBe(60000);
      expect(r2.fallback).toBe("abort");
    });
  });

  describe("executeTrigger", () => {
    test("calls chain.prompt with constructed request", async () => {
      const config = makeSlicedConfig({});
      const context: TriggerContext = { featureName: "my-feature" };
      let called = false;
      const chain = makeInteractionChain({
        prompt: async (req: unknown) => {
          called = true;
          expect((req as { id: string }).id.startsWith("trigger-")).toBe(true);
          return { action: "approve" } as const;
        },
        applyFallback: (_r: unknown, _f: string) => "approve" as const,
      });

      const response = await executeTrigger("security-review", context, config, chain);
      expect(called).toBe(true);
      expect(response.action).toBe("approve");
    });
  });

  describe("check* functions — disabled or not configured returns no-op value", () => {
    const ctx = { featureName: "f" };
    const empty = makeSlicedConfig({});

    test("checkSecurityReview: true when disabled or not configured", async () => {
      expect(await checkSecurityReview(ctx, makeSlicedConfig({ "security-review": false }), mockChain)).toBe(true);
      expect(await checkSecurityReview(ctx, empty, mockChain)).toBe(true);
    });

    test("checkCostExceeded: true when disabled or not configured", async () => {
      expect(await checkCostExceeded(ctx, makeSlicedConfig({ "cost-exceeded": false }), mockChain)).toBe(true);
      expect(await checkCostExceeded(ctx, empty, mockChain)).toBe(true);
    });

    test("checkMergeConflict: true when disabled or not configured", async () => {
      expect(await checkMergeConflict(ctx, makeSlicedConfig({ "merge-conflict": false }), mockChain)).toBe(true);
      expect(await checkMergeConflict(ctx, empty, mockChain)).toBe(true);
    });

    test("checkCostWarning: continue when disabled or not configured", async () => {
      expect(await checkCostWarning(ctx, makeSlicedConfig({ "cost-warning": false }), mockChain)).toBe("continue");
      expect(await checkCostWarning(ctx, empty, mockChain)).toBe("continue");
    });

    test("checkMaxRetries: continue when disabled or not configured", async () => {
      expect(await checkMaxRetries(ctx, makeSlicedConfig({ "max-retries": false }), mockChain)).toBe("continue");
      expect(await checkMaxRetries(ctx, empty, mockChain)).toBe("continue");
    });

    test("checkPreMerge: true when disabled or not configured", async () => {
      expect(await checkPreMerge(ctx, makeSlicedConfig({ "pre-merge": false }), mockChain)).toBe(true);
      expect(await checkPreMerge(ctx, empty, mockChain)).toBe(true);
    });

    test("returns true when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkPreMerge({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });
  });

  describe("checkReviewGate", () => {
    test("returns true when trigger disabled", async () => {
      const config = makeSlicedConfig({ "review-gate": false });
      const result = await checkReviewGate({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });

    test("returns true when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkReviewGate({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });
  });
});
