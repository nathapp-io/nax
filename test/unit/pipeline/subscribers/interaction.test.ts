// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { wireInteraction } from "../../../../src/pipeline/subscribers/interaction";
import { PipelineEventBus } from "../../../../src/pipeline/event-bus";
import { DEFAULT_CONFIG } from "../../../../src/config";

describe("wireInteraction", () => {
  test("no subscriptions when interactionChain is null", () => {
    const bus = new PipelineEventBus();
    wireInteraction(bus, null, DEFAULT_CONFIG);
    expect(bus.subscriberCount("human-review:requested")).toBe(0);
  });

  test("no subscriptions when human-review trigger is disabled", () => {
    const bus = new PipelineEventBus();
    const config = {
      ...DEFAULT_CONFIG,
      interaction: { ...DEFAULT_CONFIG.interaction, triggers: { "human-review": { enabled: false } } },
    } as any;
    const chain = {} as any;
    wireInteraction(bus, chain, config);
    expect(bus.subscriberCount("human-review:requested")).toBe(0);
  });

  test("returns unsubscribe function", () => {
    const bus = new PipelineEventBus();
    const unsub = wireInteraction(bus, null, DEFAULT_CONFIG);
    expect(typeof unsub).toBe("function");
    unsub(); // should not throw
  });
});
