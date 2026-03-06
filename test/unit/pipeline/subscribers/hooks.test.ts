// RE-ARCH: keep
import { describe, expect, test, mock } from "bun:test";
import { wireHooks } from "../../../../src/pipeline/subscribers/hooks";
import { PipelineEventBus } from "../../../../src/pipeline/event-bus";
import type { LoadedHooksConfig } from "../../../../src/hooks";

const EMPTY_HOOKS: LoadedHooksConfig = {};

describe("wireHooks", () => {
  test("subscribes to all lifecycle events", () => {
    const bus = new PipelineEventBus();
    wireHooks(bus, EMPTY_HOOKS, "/tmp", "test-feature");

    // Check subscriptions are registered
    const events = ["run:started", "story:started", "story:completed", "story:failed", "story:paused", "run:paused", "run:completed"] as const;
    for (const ev of events) {
      expect(bus.subscriberCount(ev)).toBe(1);
    }
  });

  test("returns unsubscribe function that removes all subscriptions", () => {
    const bus = new PipelineEventBus();
    const unsub = wireHooks(bus, EMPTY_HOOKS, "/tmp", "test-feature");

    unsub();

    const events = ["run:started", "story:started", "story:completed"] as const;
    for (const ev of events) {
      expect(bus.subscriberCount(ev)).toBe(0);
    }
  });

  test("errors in hooks don't propagate to callers", async () => {
    const bus = new PipelineEventBus();
    const badHooks: LoadedHooksConfig = {
      "on-story-complete": { command: "exit 1", timeout: 1 } as any,
    };
    wireHooks(bus, badHooks, "/tmp", "test-feature");

    // Should not throw
    expect(() =>
      bus.emit({ type: "story:completed", storyId: "US-001", story: { id: "US-001" } as any, passed: true, durationMs: 100 }),
    ).not.toThrow();
  });
});
