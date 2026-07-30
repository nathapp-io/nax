import { afterEach, describe, expect, test } from "bun:test";
import { withTimerSpy } from "@test/helpers";
import {
  type Heartbeat,
  type HeartbeatSnapshot,
  buildHeartbeatMetricsPayload,
  startHeartbeat,
} from "../../../../src/plugins/builtin/otel-reporter/heartbeat";
import { attr } from "../../../../src/plugins/builtin/otel-reporter/otlp";

function snapshot(overrides: Partial<HeartbeatSnapshot> = {}): HeartbeatSnapshot {
  return {
    attributes: {
      runId: "r1",
      feature: "f",
      project: "nax",
      storyId: "s1",
      phase: "implementer",
      tier: "balanced",
      testStrategy: "tdd-simple",
    },
    phaseElapsedMs: 0,
    costUsd: 0,
    ...overrides,
  };
}

const liveHeartbeats: Heartbeat[] = [];

function track(hb: Heartbeat): Heartbeat {
  liveHeartbeats.push(hb);
  return hb;
}

afterEach(() => {
  for (const hb of liveHeartbeats.splice(0)) hb.stop();
});

describe("startHeartbeat", () => {
  test("AC1: issues a tick once intervalMs has elapsed", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    track(startHeartbeat({ intervalMs: 40, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) }));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ticks.length).toBeGreaterThanOrEqual(1);
  });

  test("AC1 boundary: issues no tick before intervalMs has elapsed", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    track(startHeartbeat({ intervalMs: 200, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) }));

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticks).toHaveLength(0);
  });

  test("AC6: intervalMs=0 disables the heartbeat regardless of elapsed time", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    track(startHeartbeat({ intervalMs: 0, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) }));

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ticks).toHaveLength(0);
  });

  test("AC7: stop() prevents further ticks", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    const hb = startHeartbeat({ intervalMs: 30, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) });

    await new Promise((resolve) => setTimeout(resolve, 100));
    hb.stop();
    const countAtStop = ticks.length;

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(ticks.length).toBe(countAtStop);
  });

  test("AC7: stop() clears the underlying timer (no leaked handle)", async () => {
    const { leaked } = await withTimerSpy(async () => {
      const hb = startHeartbeat({ intervalMs: 30, getSnapshot: () => snapshot(), onTick: () => {} });
      hb.stop();
      return hb;
    });

    expect(leaked).toHaveLength(0);
  });

  test("tick snapshot carries the caller-supplied attributes", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    track(
      startHeartbeat({
        intervalMs: 30,
        getSnapshot: () => snapshot({ phaseElapsedMs: 42, costUsd: 1.23 }),
        onTick: (s) => ticks.push(s),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ticks[0]?.phaseElapsedMs).toBe(42);
    expect(ticks[0]?.costUsd).toBe(1.23);
  });

  test("a synchronously throwing getSnapshot does not stop subsequent ticks", async () => {
    let calls = 0;
    track(
      startHeartbeat({
        intervalMs: 30,
        getSnapshot: () => {
          calls++;
          throw new Error("boom");
        },
        onTick: () => {},
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("an onTick that returns a rejected promise does not stop subsequent ticks", async () => {
    let calls = 0;
    track(
      startHeartbeat({
        intervalMs: 30,
        getSnapshot: () => snapshot(),
        onTick: async () => {
          calls++;
          throw new Error("boom");
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("buildHeartbeatMetricsPayload", () => {
  // biome-ignore lint/suspicious/noExplicitAny: testing dynamic OTLP payload
  const payload: any = buildHeartbeatMetricsPayload({
    serviceName: "nax",
    timeUnixNano: "5000",
    snapshot: snapshot({ phaseElapsedMs: 250, costUsd: 1.5 }),
  });
  const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
  // biome-ignore lint/suspicious/noExplicitAny: accessing untyped metric entries
  const byName = (n: string) => metrics.find((m: any) => m.name === n);

  test("nests one resource metrics entry with service.name resource attr", () => {
    const rm = payload.resourceMetrics[0];
    expect(rm.resource.attributes).toContainEqual(attr("service.name", "nax"));
  });

  test("AC1: emits a nax.run.active gauge with value 1", () => {
    expect(byName("nax.run.active").gauge.dataPoints[0].asDouble).toBe(1);
  });

  test("AC2: emits a nax.run.phase_elapsed_ms gauge equal to the snapshot's phaseElapsedMs", () => {
    expect(byName("nax.run.phase_elapsed_ms").gauge.dataPoints[0].asDouble).toBe(250);
  });

  test("AC3: emits a nax.run.cost_usd gauge equal to the snapshot's costUsd", () => {
    expect(byName("nax.run.cost_usd").gauge.dataPoints[0].asDouble).toBe(1.5);
  });

  test("AC4+AC5: every gauge data point carries phase, run_id, feature, project, story_id, tier, and test_strategy attributes", () => {
    for (const name of ["nax.run.active", "nax.run.phase_elapsed_ms", "nax.run.cost_usd"]) {
      const attrs = byName(name).gauge.dataPoints[0].attributes;
      expect(attrs).toContainEqual(attr("run_id", "r1"));
      expect(attrs).toContainEqual(attr("feature", "f"));
      expect(attrs).toContainEqual(attr("project", "nax"));
      expect(attrs).toContainEqual(attr("story_id", "s1"));
      expect(attrs).toContainEqual(attr("phase", "implementer"));
      expect(attrs).toContainEqual(attr("tier", "balanced"));
      expect(attrs).toContainEqual(attr("test_strategy", "tdd-simple"));
    }
  });

  test("data points carry the given timeUnixNano", () => {
    expect(byName("nax.run.active").gauge.dataPoints[0].timeUnixNano).toBe("5000");
  });
});
