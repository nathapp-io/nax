import { describe, test, expect } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import type { InteractionChain } from "../../../src/interaction/chain";
import type { TriggerName } from "../../../src/interaction/types";
import {
  isTriggerEnabled,
  getTriggerConfig,
  createTriggerRequest,
  executeTrigger,
  checkSecurityReview,
  checkCostExceeded,
  checkMergeConflict,
  checkCostWarning,
  checkMaxRetries,
  checkPreMerge,
  checkStoryAmbiguity,
  checkReviewGate,
  type TriggerContext,
} from "../../../src/interaction/triggers";

const makeSlicedConfig = (triggers: Partial<Record<TriggerName, unknown>>, defaults: Record<string, unknown> = {}): NaxConfig =>
  ({ interaction: { triggers: triggers as Record<string, unknown>, defaults } } as NaxConfig);

const mockChain = {
  prompt: async () => ({ action: "approve" } as const),
  applyFallback: (_r: unknown, _f: string) => "approve" as const,
} as unknown as InteractionChain;

describe("triggers — narrowed config (Pick<NaxConfig, 'interaction'>)", () => {
  describe("isTriggerEnabled", () => {
    test("returns false when trigger not configured", () => {
      const config = makeSlicedConfig({});
      expect(isTriggerEnabled("security-review", config)).toBe(false);
    });

    test("returns boolean true when trigger is true", () => {
      const config = makeSlicedConfig({ "security-review": true });
      expect(isTriggerEnabled("security-review", config)).toBe(true);
    });

    test("returns enabled from object config", () => {
      const config = makeSlicedConfig({ "security-review": { enabled: true } });
      expect(isTriggerEnabled("security-review", config)).toBe(true);
    });

    test("returns false when enabled is false", () => {
      const config = makeSlicedConfig({ "security-review": { enabled: false } });
      expect(isTriggerEnabled("security-review", config)).toBe(false);
    });
  });

  describe("getTriggerConfig", () => {
    test("returns metadata defaultFallback when trigger not configured", () => {
      const config = makeSlicedConfig({}, { timeout: 30000, fallback: "approve" });
      const result = getTriggerConfig("security-review", config);
      expect(result.timeout).toBe(30000);
      expect(result.fallback).toBe("abort");
    });

    test("overrides defaults with trigger config", () => {
      const config = makeSlicedConfig(
        { "security-review": { timeout: 60000, fallback: "escalate" } },
        { timeout: 30000, fallback: "approve" },
      );
      const result = getTriggerConfig("security-review", config);
      expect(result.timeout).toBe(60000);
      expect(result.fallback).toBe("escalate");
    });
  });

  describe("createTriggerRequest", () => {
    test("creates request with correct id prefix", () => {
      const config = makeSlicedConfig({});
      const context: TriggerContext = { featureName: "my-feature" };
      const request = createTriggerRequest("security-review", context, config);
      expect(request.id.startsWith("trigger-security-review-")).toBe(true);
      expect(request.type).toBe("confirm");
    });

    test("uses metadata defaultFallback when trigger not configured", () => {
      const config = makeSlicedConfig({}, { timeout: 60000, fallback: "escalate" });
      const context: TriggerContext = { featureName: "my-feature" };
      const request = createTriggerRequest("security-review", context, config);
      expect(request.timeout).toBe(60000);
      expect(request.fallback).toBe("abort");
    });
  });

  describe("executeTrigger", () => {
    test("calls chain.prompt with constructed request", async () => {
      const config = makeSlicedConfig({});
      const context: TriggerContext = { featureName: "my-feature" };
      let called = false;
      const chain = {
        prompt: async (req: unknown) => {
          called = true;
          expect((req as { id: string }).id.startsWith("trigger-")).toBe(true);
          return { action: "approve" } as const;
        },
        applyFallback: (_r: unknown, _f: string) => "approve" as const,
      } as unknown as InteractionChain;

      const response = await executeTrigger("security-review", context, config, chain);
      expect(called).toBe(true);
      expect(response.action).toBe("approve");
    });
  });

  describe("checkSecurityReview", () => {
    test("returns true when trigger disabled", async () => {
      const config = makeSlicedConfig({ "security-review": false });
      const result = await checkSecurityReview({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });

    test("returns true when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkSecurityReview({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });
  });

  describe("checkCostExceeded", () => {
    test("returns true when trigger disabled", async () => {
      const config = makeSlicedConfig({ "cost-exceeded": false });
      const result = await checkCostExceeded({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });

    test("returns true when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkCostExceeded({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });
  });

  describe("checkMergeConflict", () => {
    test("returns true when trigger disabled", async () => {
      const config = makeSlicedConfig({ "merge-conflict": false });
      const result = await checkMergeConflict({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });

    test("returns true when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkMergeConflict({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });
  });

  describe("checkCostWarning", () => {
    test("returns continue when trigger disabled", async () => {
      const config = makeSlicedConfig({ "cost-warning": false });
      const result = await checkCostWarning({ featureName: "f" }, config, mockChain);
      expect(result).toBe("continue");
    });

    test("returns continue when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkCostWarning({ featureName: "f" }, config, mockChain);
      expect(result).toBe("continue");
    });
  });

  describe("checkMaxRetries", () => {
    test("returns continue when trigger disabled", async () => {
      const config = makeSlicedConfig({ "max-retries": false });
      const result = await checkMaxRetries({ featureName: "f" }, config, mockChain);
      expect(result).toBe("continue");
    });

    test("returns continue when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkMaxRetries({ featureName: "f" }, config, mockChain);
      expect(result).toBe("continue");
    });
  });

  describe("checkPreMerge", () => {
    test("returns true when trigger disabled", async () => {
      const config = makeSlicedConfig({ "pre-merge": false });
      const result = await checkPreMerge({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });

    test("returns true when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkPreMerge({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });
  });

  describe("checkStoryAmbiguity", () => {
    test("returns true when trigger disabled", async () => {
      const config = makeSlicedConfig({ "story-ambiguity": false });
      const result = await checkStoryAmbiguity({ featureName: "f" }, config, mockChain);
      expect(result).toBe(true);
    });

    test("returns true when no trigger configured", async () => {
      const config = makeSlicedConfig({});
      const result = await checkStoryAmbiguity({ featureName: "f" }, config, mockChain);
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