// RE-ARCH: keep
import { describe, expect, spyOn, test } from "bun:test";
import * as loggerModule from "@/logger";
import { PipelineEventBus, wireReporters } from "@/pipeline";
import type { PluginRegistry } from "@/plugins";
import type { IReporter, PhaseCompleteEvent, PhaseStartEvent, RunStartEvent } from "@/plugins/types";

function makeReporter(): IReporter & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "test-reporter",
    calls,
    async onRunStart() {
      calls.push("onRunStart");
    },
    async onStoryComplete(ev) {
      calls.push(`onStoryComplete:${ev.status}`);
    },
    async onRunEnd() {
      calls.push("onRunEnd");
    },
    async onEscalation(ev) {
      calls.push(`onEscalation:${ev.fromTier}->${ev.toTier}`);
    },
  };
}

function makeRegistry(...reporters: IReporter[]): PluginRegistry {
  return { getReporters: () => reporters } as PluginRegistry;
}

describe("wireReporters", () => {
  test("run:started fires onRunStart", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({ type: "run:started", feature: "test", totalStories: 5, workdir: "/tmp" });

    await Promise.resolve();
    expect(reporter.calls).toContain("onRunStart");
  });

  test("run:started passes the project key through to onRunStart", async () => {
    const bus = new PipelineEventBus();
    let received: RunStartEvent | undefined;
    const reporter: IReporter = {
      name: "capture-reporter",
      async onRunStart(ev) {
        received = ev;
      },
    };
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "my-project");

    bus.emit({ type: "run:started", feature: "test", totalStories: 5, workdir: "/tmp" });

    await Promise.resolve();
    expect(received?.project).toBe("my-project");
  });

  test("story:completed fires onStoryComplete(completed)", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({
      type: "story:completed",
      storyId: "US-001",
      story: { id: "US-001" } as any,
      passed: true,
      runElapsedMs: 100,
    });

    await Promise.resolve();
    expect(reporter.calls).toContain("onStoryComplete:completed");
  });

  test("story:failed fires onStoryComplete(failed)", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({
      type: "story:failed",
      storyId: "US-001",
      story: { id: "US-001" } as any,
      reason: "tests failed",
      countsTowardEscalation: true,
    });

    await Promise.resolve();
    expect(reporter.calls).toContain("onStoryComplete:failed");
  });

  test("story:paused fires onStoryComplete(paused)", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({ type: "story:paused", storyId: "US-001", reason: "needs review", cost: 0.5 });

    await Promise.resolve();
    expect(reporter.calls).toContain("onStoryComplete:paused");
  });

  test("story:escalated fires onEscalation", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({ type: "story:escalated", storyId: "US-001", fromTier: "fast", toTier: "balanced" });

    await Promise.resolve();
    expect(reporter.calls).toContain("onEscalation:fast->balanced");
  });

  test("run:completed fires onRunEnd", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({ type: "run:completed", totalStories: 5, passedStories: 4, failedStories: 1, durationMs: 60000 });

    await Promise.resolve();
    expect(reporter.calls).toContain("onRunEnd");
  });

  test("reporter errors don't propagate", async () => {
    const bus = new PipelineEventBus();
    const badReporter: IReporter = {
      name: "bad",
      async onStoryComplete() {
        throw new Error("reporter crash");
      },
    };
    wireReporters(bus, makeRegistry(badReporter), "run-1", Date.now(), "test-project");

    expect(() =>
      bus.emit({
        type: "story:completed",
        storyId: "US-001",
        story: { id: "US-001" } as any,
        passed: true,
        runElapsedMs: 100,
      }),
    ).not.toThrow();
  });

  test("AC1, AC2, AC9: story:step maps to a story phase start", async () => {
    const events: PhaseStartEvent[] = [];
    const reporter: IReporter = {
      name: "phase",
      async onPhaseStart(event) {
        events.push(event);
      },
    };
    const bus = new PipelineEventBus();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({ type: "story:step", storyId: "US-005", step: "implementer" });
    await bus.drain();

    expect(events).toEqual([
      expect.objectContaining({ runId: "run-1", scope: "story", storyId: "US-005", phase: "implementer" }),
    ]);
  });

  test("AC3, AC4, AC5, AC9: story phase completion maps its telemetry", async () => {
    const events: PhaseCompleteEvent[] = [];
    const reporter: IReporter = {
      name: "phase",
      async onPhaseComplete(event) {
        events.push(event);
      },
    };
    const bus = new PipelineEventBus();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({
      type: "story:phase:completed",
      storyId: "US-005",
      phase: "implementer",
      outcome: "passed",
      durationMs: 12,
      costUsd: 0.25,
    });
    await bus.drain();

    expect(events).toEqual([
      expect.objectContaining({
        runId: "run-1",
        scope: "story",
        storyId: "US-005",
        phase: "implementer",
        outcome: "passed",
        costUsd: 0.25,
      }),
    ]);
  });

  test("AC6, AC7, AC9: post-run phase start maps without storyId", async () => {
    const events: PhaseStartEvent[] = [];
    const reporter: IReporter = {
      name: "phase",
      async onPhaseStart(event) {
        events.push(event);
      },
    };
    const bus = new PipelineEventBus();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({ type: "postrun:phase:started", phase: "acceptance" });
    await bus.drain();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({ runId: "run-1", scope: "run", phase: "acceptance" }));
    expect(events[0]).not.toHaveProperty("storyId");
  });

  test("AC8, AC9: post-run phase completion maps to run scope", async () => {
    const events: PhaseCompleteEvent[] = [];
    const reporter: IReporter = {
      name: "phase",
      async onPhaseComplete(event) {
        events.push(event);
      },
    };
    const bus = new PipelineEventBus();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({ type: "postrun:phase:completed", phase: "acceptance", passed: true, durationMs: 15 });
    await bus.drain();

    expect(events).toEqual([
      expect.objectContaining({ runId: "run-1", scope: "run", phase: "acceptance", outcome: "passed", durationMs: 15 }),
    ]);
  });

  test("post-run phase completion with no measured cost leaves costUsd absent, not fabricated 0", async () => {
    const events: PhaseCompleteEvent[] = [];
    const reporter: IReporter = {
      name: "phase",
      async onPhaseComplete(event) {
        events.push(event);
      },
    };
    const bus = new PipelineEventBus();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");

    bus.emit({ type: "postrun:phase:completed", phase: "regression", passed: true, durationMs: 10 });
    await bus.drain();

    expect(events[0]?.costUsd).toBeUndefined();
  });

  test("AC10: skips reporters without onPhaseComplete", async () => {
    const bus = new PipelineEventBus();
    wireReporters(bus, makeRegistry({ name: "legacy" }), "run-1", Date.now(), "test-project");

    bus.emit({
      type: "story:phase:completed",
      storyId: "US-005",
      phase: "implementer",
      outcome: "passed",
      durationMs: 1,
      costUsd: 0,
    });

    await expect(bus.drain()).resolves.toBeUndefined();
  });

  test("AC11: isolates phase completion failures between reporters", async () => {
    const calls: string[] = [];
    const first: IReporter = {
      name: "first",
      async onPhaseComplete() {
        throw new Error("failed");
      },
    };
    const second: IReporter = {
      name: "second",
      async onPhaseComplete() {
        calls.push("second");
      },
    };
    const bus = new PipelineEventBus();
    wireReporters(bus, makeRegistry(first, second), "run-1", Date.now(), "test-project");

    bus.emit({
      type: "story:phase:completed",
      storyId: "US-005",
      phase: "implementer",
      outcome: "failed",
      durationMs: 1,
      costUsd: 0,
    });
    await bus.drain();

    expect(calls).toEqual(["second"]);
  });

  test("isolates logger failures while continuing phase completion fan-out", async () => {
    const warn = spyOn(loggerModule.getSafeLogger()!, "warn").mockImplementation(() => {
      throw new Error("logger failed");
    });
    const calls: string[] = [];
    const first: IReporter = {
      name: "first",
      async onPhaseComplete() {
        throw new Error("reporter failed");
      },
    };
    const second: IReporter = {
      name: "second",
      async onPhaseComplete() {
        calls.push("second");
      },
    };
    const bus = new PipelineEventBus();
    wireReporters(bus, makeRegistry(first, second), "run-1", Date.now(), "test-project");

    bus.emit({
      type: "story:phase:completed",
      storyId: "US-005",
      phase: "implementer",
      outcome: "failed",
      durationMs: 1,
      costUsd: 0,
    });
    await bus.drain();
    warn.mockRestore();

    expect(calls).toEqual(["second"]);
  });

  test("AC13: unsubscribe stops phase completion delivery", async () => {
    const events: PhaseCompleteEvent[] = [];
    const reporter: IReporter = {
      name: "phase",
      async onPhaseComplete(event) {
        events.push(event);
      },
    };
    const bus = new PipelineEventBus();
    const unsubscribe = wireReporters(bus, makeRegistry(reporter), "run-1", Date.now(), "test-project");
    const event = {
      type: "story:phase:completed" as const,
      storyId: "US-005",
      phase: "implementer",
      outcome: "passed" as const,
      durationMs: 1,
      costUsd: 0,
    };

    bus.emit(event);
    await bus.drain();
    unsubscribe();
    bus.emit(event);
    await bus.drain();

    expect(events).toHaveLength(1);
  });
});
