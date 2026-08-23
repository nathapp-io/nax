import { describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config";
import {
  type TriggerContext,
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
} from "@/interaction/triggers";
import type { TriggerName } from "@/interaction/types";
import { makeInteractionChain } from "@test/helpers";

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
