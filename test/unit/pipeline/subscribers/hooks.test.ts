// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import type { LoadedHooksConfig } from "@/hooks";
import { PipelineEventBus } from "@/pipeline/event-bus";
import { wireHooks } from "@/pipeline/subscribers/hooks";

const EMPTY_HOOKS: LoadedHooksConfig = { hooks: {} };

const STORY_SUMMARY = { id: "US-001", title: "US-001", status: "pending", attempts: 1 };

describe("wireHooks", () => {
  test("subscribes to all lifecycle events", () => {
    const bus = new PipelineEventBus();
    wireHooks(bus, EMPTY_HOOKS, "/tmp", "test-feature");

    // Single-subscriber events
    const singleSubEvents = [
      "run:started",
      "story:started",
      "story:paused",
      "run:paused",
      "run:completed",
      "run:resumed",
      "run:errored",
    ] as const;
    for (const ev of singleSubEvents) {
      expect(bus.subscriberCount(ev)).toBe(1);
    }
    // story:completed and story:failed each have 2: on-story-complete/fail + on-session-end
    expect(bus.subscriberCount("story:completed")).toBe(2);
    expect(bus.subscriberCount("story:failed")).toBe(2);
  });

  test("returns unsubscribe function that removes all subscriptions", () => {
    const bus = new PipelineEventBus();
    const unsub = wireHooks(bus, EMPTY_HOOKS, "/tmp", "test-feature");

    unsub();

    const events = ["run:started", "story:started", "story:completed", "run:resumed", "run:errored"] as const;
    for (const ev of events) {
      expect(bus.subscriberCount(ev)).toBe(0);
    }
  });

  test("errors in hooks don't propagate to callers", async () => {
    const bus = new PipelineEventBus();
    const badHooks: LoadedHooksConfig = {
      hooks: {
        "on-story-complete": { command: "exit 1", timeout: 1 },
      },
    };
    wireHooks(bus, badHooks, "/tmp", "test-feature");

    // Should not throw
    expect(() =>
      bus.emit({
        type: "story:completed",
        storyId: "US-001",
        story: STORY_SUMMARY,
        passed: true,
        runElapsedMs: 100,
      }),
    ).not.toThrow();
  });

  test("on-resume: run:resumed event triggers on-resume hook (fire-and-forget, no throw)", () => {
    const bus = new PipelineEventBus();
    wireHooks(bus, EMPTY_HOOKS, "/tmp", "test-feature");

    expect(() => bus.emit({ type: "run:resumed", feature: "test-feature" })).not.toThrow();
  });

  test("on-session-end: story:completed triggers on-session-end with status passed (fire-and-forget, no throw)", () => {
    const bus = new PipelineEventBus();
    wireHooks(bus, EMPTY_HOOKS, "/tmp", "test-feature");

    expect(() =>
      bus.emit({
        type: "story:completed",
        storyId: "US-001",
        story: STORY_SUMMARY,
        passed: true,
        runElapsedMs: 100,
      }),
    ).not.toThrow();
  });

  test("on-session-end: story:failed triggers on-session-end with status failed (fire-and-forget, no throw)", () => {
    const bus = new PipelineEventBus();
    wireHooks(bus, EMPTY_HOOKS, "/tmp", "test-feature");

    expect(() =>
      bus.emit({
        type: "story:failed",
        storyId: "US-001",
        story: STORY_SUMMARY,
        reason: "test failure",
        countsTowardEscalation: true,
      }),
    ).not.toThrow();
  });

  test("on-error: run:errored event triggers on-error hook (fire-and-forget, no throw)", () => {
    const bus = new PipelineEventBus();
    wireHooks(bus, EMPTY_HOOKS, "/tmp", "test-feature");

    expect(() => bus.emit({ type: "run:errored", reason: "SIGTERM", feature: "test-feature" })).not.toThrow();
  });
});
