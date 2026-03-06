// RE-ARCH: keep
import { describe, expect, test } from "bun:test";
import { wireReporters } from "../../../../src/pipeline/subscribers/reporters";
import { PipelineEventBus } from "../../../../src/pipeline/event-bus";
import type { IReporter } from "../../../../src/plugins/types";

function makeReporter(): IReporter & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "test-reporter",
    calls,
    async onRunStart() { calls.push("onRunStart"); },
    async onStoryComplete(ev) { calls.push(`onStoryComplete:${ev.status}`); },
    async onRunEnd() { calls.push("onRunEnd"); },
  };
}

function makeRegistry(reporter: IReporter) {
  return { getReporters: () => [reporter] } as any;
}

describe("wireReporters", () => {
  test("run:started fires onRunStart", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now());

    bus.emit({ type: "run:started", feature: "test", totalStories: 5, workdir: "/tmp" });

    await Bun.sleep(10); // let fire-and-forget settle
    expect(reporter.calls).toContain("onRunStart");
  });

  test("story:completed fires onStoryComplete(completed)", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now());

    bus.emit({ type: "story:completed", storyId: "US-001", story: { id: "US-001" } as any, passed: true, durationMs: 100 });

    await Bun.sleep(10);
    expect(reporter.calls).toContain("onStoryComplete:completed");
  });

  test("story:failed fires onStoryComplete(failed)", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now());

    bus.emit({ type: "story:failed", storyId: "US-001", story: { id: "US-001" } as any, reason: "tests failed", countsTowardEscalation: true });

    await Bun.sleep(10);
    expect(reporter.calls).toContain("onStoryComplete:failed");
  });

  test("story:paused fires onStoryComplete(paused)", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now());

    bus.emit({ type: "story:paused", storyId: "US-001", reason: "needs review", cost: 0.5 });

    await Bun.sleep(10);
    expect(reporter.calls).toContain("onStoryComplete:paused");
  });

  test("run:completed fires onRunEnd", async () => {
    const bus = new PipelineEventBus();
    const reporter = makeReporter();
    wireReporters(bus, makeRegistry(reporter), "run-1", Date.now());

    bus.emit({ type: "run:completed", totalStories: 5, passedStories: 4, failedStories: 1, durationMs: 60000 });

    await Bun.sleep(10);
    expect(reporter.calls).toContain("onRunEnd");
  });

  test("reporter errors don't propagate", async () => {
    const bus = new PipelineEventBus();
    const badReporter: IReporter = {
      name: "bad",
      async onStoryComplete() { throw new Error("reporter crash"); },
    };
    wireReporters(bus, makeRegistry(badReporter), "run-1", Date.now());

    expect(() =>
      bus.emit({ type: "story:completed", storyId: "US-001", story: { id: "US-001" } as any, passed: true, durationMs: 100 }),
    ).not.toThrow();
  });
});
