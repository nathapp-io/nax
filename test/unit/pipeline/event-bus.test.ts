// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { PipelineEventBus } from "../../../src/pipeline/event-bus";
import type { PipelineEvent } from "../../../src/pipeline/event-bus";

function makeStoryCompletedEvent(): PipelineEvent {
  return {
    type: "story:completed",
    storyId: "US-001",
    story: { id: "US-001", title: "Test story", status: "passed", acceptanceCriteria: [] } as any,
    passed: true,
    durationMs: 1000,
  };
}

function makeStoryPhaseCompletedEvent(): PipelineEvent {
  return {
    type: "story:phase:completed",
    storyId: "US-001",
    phase: "implementer",
    outcome: "passed",
    durationMs: 120,
    costUsd: 0.42,
  };
}

describe("PipelineEventBus", () => {
  test("subscribes and receives event", () => {
    const bus = new PipelineEventBus();
    const received: PipelineEvent[] = [];
    bus.on("story:completed", (e) => received.push(e));

    const evt = makeStoryCompletedEvent();
    bus.emit(evt);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(evt);
  });

  test("onAll receives all event types", () => {
    const bus = new PipelineEventBus();
    const received: string[] = [];
    bus.onAll((e) => received.push(e.type));

    bus.emit(makeStoryCompletedEvent());
    bus.emit({ type: "run:completed", totalStories: 1, passedStories: 1, failedStories: 0, durationMs: 5000 });

    expect(received).toEqual(["story:completed", "run:completed"]);
  });

  test("unsubscribe stops receiving events", () => {
    const bus = new PipelineEventBus();
    const received: PipelineEvent[] = [];
    const unsub = bus.on("story:completed", (e) => received.push(e));

    bus.emit(makeStoryCompletedEvent());
    unsub();
    bus.emit(makeStoryCompletedEvent());

    expect(received).toHaveLength(1);
  });

  test("subscriber error does not prevent other subscribers from running", () => {
    const bus = new PipelineEventBus();
    const results: string[] = [];

    bus.on("story:completed", () => { throw new Error("boom"); });
    bus.on("story:completed", () => results.push("second"));

    bus.emit(makeStoryCompletedEvent());

    expect(results).toEqual(["second"]);
  });

  test("subscriberCount returns correct count", () => {
    const bus = new PipelineEventBus();
    expect(bus.subscriberCount("story:completed")).toBe(0);

    bus.on("story:completed", () => {});
    bus.on("story:completed", () => {});
    expect(bus.subscriberCount("story:completed")).toBe(2);
  });

  test("clear removes all subscribers", () => {
    const bus = new PipelineEventBus();
    const received: PipelineEvent[] = [];
    bus.on("story:completed", (e) => received.push(e));
    bus.clear();
    bus.emit(makeStoryCompletedEvent());

    expect(received).toHaveLength(0);
  });

  test("emitAsync awaits all async subscribers", async () => {
    const bus = new PipelineEventBus();
    let resolved = false;

    bus.on("story:completed", async () => {
      await Promise.resolve();
      resolved = true;
    });

    await bus.emitAsync(makeStoryCompletedEvent());
    expect(resolved).toBe(true);
  });

  test("does not deliver typed events to wrong subscriber", () => {
    const bus = new PipelineEventBus();
    const received: PipelineEvent[] = [];

    bus.on("run:completed", (e) => received.push(e));
    bus.emit(makeStoryCompletedEvent());

    expect(received).toHaveLength(0);
  });

  test("story:skipped event is typed and receivable", () => {
    const bus = new PipelineEventBus();
    const received: PipelineEvent[] = [];
    bus.on("story:skipped", (e) => received.push(e));

    bus.emit({ type: "story:skipped", storyId: "US-001", reason: "user requested skip" });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("story:skipped");
  });

  test("AC1: story phase subscriber receives the emitted phase", () => {
    const bus = new PipelineEventBus();
    let receivedPhase: string | undefined;
    bus.on("story:phase:completed", (event) => {
      receivedPhase = event.phase;
    });

    bus.emit(makeStoryPhaseCompletedEvent());

    expect(receivedPhase).toBe("implementer");
  });

  test("AC2: story phase subscriber receives the emitted cost", () => {
    const bus = new PipelineEventBus();
    let receivedCost: number | undefined;
    bus.on("story:phase:completed", (event) => {
      receivedCost = event.costUsd;
    });

    bus.emit(makeStoryPhaseCompletedEvent());

    expect(receivedCost).toBe(0.42);
  });

  test("AC3: post-run phase start preserves acceptance-setup phase", () => {
    const bus = new PipelineEventBus();
    let receivedPhase: string | undefined;
    bus.on("postrun:phase:started", (event) => {
      receivedPhase = event.phase;
    });

    bus.emit({ type: "postrun:phase:started", phase: "acceptance-setup" });

    expect(receivedPhase).toBe("acceptance-setup");
  });

  test("AC4: post-run phase completion preserves details payload", () => {
    const bus = new PipelineEventBus();
    const details = { total: 3, passed: 2, failed: 1 };
    let receivedDetails: unknown;
    bus.on("postrun:phase:completed", (event) => {
      receivedDetails = event.details;
    });

    bus.emit({
      type: "postrun:phase:completed",
      phase: "acceptance",
      passed: false,
      details,
    });

    expect(receivedDetails).toBe(details);
  });

  test("AC5: onAll receives story phase completion", () => {
    const bus = new PipelineEventBus();
    const received: PipelineEvent[] = [];
    bus.onAll((event) => received.push(event));

    const event = makeStoryPhaseCompletedEvent();
    bus.emit(event);

    expect(received).toContain(event);
  });

  test("story:escalated event is typed and receivable", () => {
    const bus = new PipelineEventBus();
    const received: PipelineEvent[] = [];
    bus.on("story:escalated", (e) => received.push(e));

    bus.emit({ type: "story:escalated", storyId: "US-001", fromTier: "fast", toTier: "balanced" });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("story:escalated");
  });

  // BUG-14: drain() previously awaited Promise.allSettled([...this._pending])
  // with no per-subscriber deadline — one subscriber promise that never
  // settles (hung hook script, webhook interaction) hung drain() forever.
  // drain() runs at every story boundary.
  describe("drain() deadline (BUG-14)", () => {
    test("a subscriber promise that never settles does not hang drain()", async () => {
      const bus = new PipelineEventBus();
      bus.on("story:completed", () => new Promise<void>(() => {})); // never resolves

      bus.emit(makeStoryCompletedEvent());

      // Small deadline override — real production default is 5s.
      await bus.drain(20);
      // If drain() hung, this line is never reached and the test times out.
      expect(true).toBe(true);
    });

    test("a settling subscriber is still awaited normally (no premature drop)", async () => {
      const bus = new PipelineEventBus();
      let settled = false;
      bus.on("story:completed", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled = true;
      });

      bus.emit(makeStoryCompletedEvent());
      await bus.drain(200);

      expect(settled).toBe(true);
    });

    test("a hung subscriber is removed from the pending set so a later drain() does not wait on it again", async () => {
      const bus = new PipelineEventBus();
      bus.on("story:completed", () => new Promise<void>(() => {}));

      bus.emit(makeStoryCompletedEvent());
      await bus.drain(20);

      const start = Date.now();
      await bus.drain(20);
      // Second drain should resolve immediately — nothing pending (or, if
      // still pending for some reason, at least not compound the deadline).
      expect(Date.now() - start).toBeLessThan(100);
    });

    test("multiple pending subscribers: a hung one does not block a settling one from being awaited", async () => {
      const bus = new PipelineEventBus();
      let fastSettled = false;
      bus.on("story:completed", () => new Promise<void>(() => {})); // hangs
      bus.on("story:completed", async () => {
        fastSettled = true;
      });

      bus.emit(makeStoryCompletedEvent());
      await bus.drain(20);

      expect(fastSettled).toBe(true);
    });
  });
});
