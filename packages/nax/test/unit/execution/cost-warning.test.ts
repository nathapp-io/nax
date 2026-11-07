import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeInteractionChain, makeNaxConfig, makeSequentialExecutionContext } from "@test/helpers";
import type { NaxConfig } from "@/config";
import { maybeSendCostWarning } from "@/execution/cost-warning";

afterEach(() => mock.restore());

type WarningConfig = NonNullable<NonNullable<NaxConfig["interaction"]>["triggers"]>["cost-warning"];

describe("maybeSendCostWarning", () => {
  test.each([
    { trigger: true, cost: 7.99, sent: false },
    { trigger: true, cost: 8, sent: true },
    { trigger: { enabled: true }, cost: 8, sent: true },
    { trigger: { enabled: true, threshold: 0.5 }, cost: 4.99, sent: false },
    { trigger: { enabled: true, threshold: 0.5 }, cost: 5, sent: true },
    { trigger: { enabled: true, threshold: 0.95 }, cost: 9, sent: false },
    { trigger: { enabled: true, threshold: 0.95 }, cost: 9.5, sent: true },
    { trigger: false, cost: 10, sent: false },
    { trigger: { enabled: false, threshold: 0.5 }, cost: 10, sent: false },
  ] satisfies { trigger: WarningConfig; cost: number; sent: boolean }[])(
    "honors the default/custom inclusive threshold and trigger switch: %j",
    async ({ trigger, cost, sent }) => {
      const chain = makeInteractionChain();
      const ctx = makeSequentialExecutionContext({
        interactionChain: chain,
        config: makeNaxConfig({ interaction: { triggers: { "cost-warning": trigger } } }),
      });
      expect(await maybeSendCostWarning(ctx, cost, 10, false)).toBe(sent);
      expect(chain.prompt).toHaveBeenCalledTimes(sent ? 1 : 0);
      if (sent) {
        expect(chain.prompt).toHaveBeenCalledWith(
          expect.objectContaining({
            featureName: ctx.feature,
            summary: `Cost warning: ${cost} USD / 10 USD — escalate to higher tier?`,
            metadata: { trigger: "cost-warning", safety: "yellow" },
          }),
        );
      }
    },
  );

  test("leaves the flag unchanged without an interaction chain", async () => {
    const ctx = makeSequentialExecutionContext({
      config: makeNaxConfig({ interaction: { triggers: { "cost-warning": true } } }),
    });
    expect(await maybeSendCostWarning(ctx, 10, 10, false)).toBe(false);
    expect(await maybeSendCostWarning(ctx, 10, 10, true)).toBe(true);
  });

  test("warns only once as spend grows and preserves the returned flag", async () => {
    const chain = makeInteractionChain();
    const ctx = makeSequentialExecutionContext({
      interactionChain: chain,
      config: makeNaxConfig({ interaction: { triggers: { "cost-warning": true } } }),
    });
    let warningSent = await maybeSendCostWarning(ctx, 7, 10, false);
    expect(warningSent).toBe(false);
    warningSent = await maybeSendCostWarning(ctx, 8, 10, warningSent);
    expect(warningSent).toBe(true);
    expect(await maybeSendCostWarning(ctx, 10, 10, warningSent)).toBe(true);
    expect(chain.prompt).toHaveBeenCalledTimes(1);
  });
});
