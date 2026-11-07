import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeInteractionChain, makeNaxConfig, makeSequentialExecutionContext } from "@test/helpers";
import { enforceCostLimit } from "@/execution/cost-guard";
import { InteractionChain } from "@/interaction/chain";
import type { InteractionResponse } from "@/interaction/types";
import { type PipelineEvent, pipelineEventBus } from "@/pipeline/event-bus";

const events: PipelineEvent[] = [];
let unsubscribe: () => void;
beforeEach(() => {
  events.length = 0;
  unsubscribe = pipelineEventBus.onAll((event) => {
    events.push(event);
  });
});
afterEach(() => {
  unsubscribe();
  mock.restore();
});

describe("enforceCostLimit", () => {
  test.each([
    { total: 3, successful: 2, failed: 0, limit: 10, enforcedCost: 3, stop: false },
    { total: 1, successful: 4, failed: 2, limit: 10, enforcedCost: 6, stop: false },
    { total: 10, successful: 2, failed: 1, limit: 10, enforcedCost: 10, stop: true },
    { total: 1, successful: 4, failed: 6, limit: 10, enforcedCost: 10, stop: true },
    { total: 0, successful: 0, failed: 11, limit: 10, enforcedCost: 11, stop: true },
    { total: 0, successful: 0, failed: 0, limit: 0, enforcedCost: 0, stop: true },
  ])("reconciles spend and stops at the inclusive limit: %j", async (row) => {
    const ctx = makeSequentialExecutionContext();
    const snapshot = ctx.runtime.costAggregator.snapshot();
    spyOn(ctx.runtime.costAggregator, "snapshot").mockReturnValue({
      ...snapshot,
      totalCostUsd: row.successful,
      totalErrorCostUsd: row.failed,
    });
    expect(await enforceCostLimit(ctx, row.total, row.limit, "US-001")).toEqual({
      stop: row.stop,
      enforcedCost: row.enforcedCost,
    });
    expect(events).toEqual(
      row.stop
        ? [
            {
              type: "run:paused",
              reason: `Cost limit reached: $${row.enforcedCost.toFixed(2)}`,
              storyId: "US-001",
              cost: row.enforcedCost,
            },
          ]
        : [],
    );
  });

  test("pauses without a story id when the interaction trigger is disabled", async () => {
    const chain = makeInteractionChain();
    const ctx = makeSequentialExecutionContext({
      interactionChain: chain,
      config: makeNaxConfig({ interaction: { triggers: { "cost-exceeded": false } } }),
    });
    expect(await enforceCostLimit(ctx, 12.345, 10)).toEqual({ stop: true, enforcedCost: 12.345 });
    expect(events).toEqual([{ type: "run:paused", reason: "Cost limit reached: $12.35", cost: 12.345 }]);
    expect(events[0]).not.toHaveProperty("storyId");
    expect(chain.prompt).not.toHaveBeenCalled();
  });

  test("does not prompt below the limit even with an enabled trigger", async () => {
    const chain = makeInteractionChain();
    const ctx = makeSequentialExecutionContext({
      interactionChain: chain,
      config: makeNaxConfig({ interaction: { triggers: { "cost-exceeded": true } } }),
    });
    expect(await enforceCostLimit(ctx, 9.99, 10)).toEqual({ stop: false, enforcedCost: 9.99 });
    expect(chain.prompt).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  test.each([
    { action: "approve", respondedBy: "user", stop: false },
    { action: "abort", respondedBy: "user", stop: true },
    { action: "approve", respondedBy: "timeout", stop: true },
  ] satisfies { action: InteractionResponse["action"]; respondedBy: string; stop: boolean }[])(
    "requires approval and fails closed on timeout: %j",
    async ({ action, respondedBy, stop }) => {
      const chain = makeInteractionChain({
        prompt: mock(async () => ({ requestId: "budget", action, respondedBy, respondedAt: 0 })),
        applyFallback: InteractionChain.prototype.applyFallback,
      });
      const ctx = makeSequentialExecutionContext({
        interactionChain: chain,
        config: makeNaxConfig({ interaction: { triggers: { "cost-exceeded": true } } }),
      });
      // Failed spend must reach the prompt as well as the stop decision.
      const snapshot = ctx.runtime.costAggregator.snapshot();
      spyOn(ctx.runtime.costAggregator, "snapshot").mockReturnValue({
        ...snapshot,
        totalCostUsd: 4,
        totalErrorCostUsd: 8,
      });
      expect(await enforceCostLimit(ctx, 1, 10, "US-001")).toEqual({ stop, enforcedCost: 12 });
      expect(chain.prompt).toHaveBeenCalledTimes(1);
      expect(chain.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          featureName: ctx.feature,
          summary: "Cost limit exceeded (12 USD) — abort execution?",
          metadata: { trigger: "cost-exceeded", safety: "red" },
        }),
      );
      expect(events).toEqual(
        stop
          ? [{ type: "run:paused", reason: "Cost limit reached: $12.00", storyId: "US-001", cost: 12 }]
          : [{ type: "run:resumed", feature: ctx.feature }],
      );
    },
  );
});
