import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeClock, makeFakeClock, withTimerSpy } from "@test/helpers";
import {
  type Heartbeat,
  type HeartbeatSnapshot,
  _heartbeatDeps,
  buildHeartbeatMetricsPayload,
  startHeartbeat,
} from "@/plugins/builtin/otel-reporter/heartbeat";
import { attr } from "@/plugins/builtin/otel-reporter/otlp";

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

// Every timer assertion below runs on a virtual clock: time moves only when the
// test advances it. That makes the tick counts exact rather than "at least N"
// — a heartbeat that fires twice as often as configured is now a failure, which
// a wall-clock sleep with a loose lower bound could never catch — and it costs
// no real time, so nothing here can flake when the machine stalls.
let clock: FakeClock;
let origSetTimeout: typeof _heartbeatDeps.setTimeout;
let origClearTimeout: typeof _heartbeatDeps.clearTimeout;

beforeEach(() => {
  clock = makeFakeClock();
  origSetTimeout = _heartbeatDeps.setTimeout;
  origClearTimeout = _heartbeatDeps.clearTimeout;
  _heartbeatDeps.setTimeout = clock.setTimeout as typeof _heartbeatDeps.setTimeout;
  _heartbeatDeps.clearTimeout = clock.clearTimeout as typeof _heartbeatDeps.clearTimeout;
});

afterEach(() => {
  for (const hb of liveHeartbeats.splice(0)) hb.stop();
  _heartbeatDeps.setTimeout = origSetTimeout;
  _heartbeatDeps.clearTimeout = origClearTimeout;
});

describe("startHeartbeat", () => {
  test("AC1: issues a tick once intervalMs has elapsed", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    track(startHeartbeat({ intervalMs: 40, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) }));

    await clock.advance(40);
    expect(ticks).toHaveLength(1);
  });

  test("AC1: keeps ticking once per interval", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    track(startHeartbeat({ intervalMs: 40, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) }));

    await clock.advance(160);
    expect(ticks).toHaveLength(4);
  });

  test("AC1 boundary: issues no tick before intervalMs has elapsed", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    track(startHeartbeat({ intervalMs: 200, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) }));

    await clock.advance(199);
    expect(ticks).toHaveLength(0);
  });

  test("AC6: intervalMs=0 disables the heartbeat regardless of elapsed time", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    track(startHeartbeat({ intervalMs: 0, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) }));

    await clock.advance(10_000);
    expect(ticks).toHaveLength(0);
    // No timer was ever armed, not merely one that failed to fire.
    expect(clock.pending()).toBe(0);
  });

  test("AC7: stop() prevents further ticks", async () => {
    const ticks: HeartbeatSnapshot[] = [];
    const hb = startHeartbeat({ intervalMs: 30, getSnapshot: () => snapshot(), onTick: (s) => ticks.push(s) });

    await clock.advance(90);
    expect(ticks).toHaveLength(3);

    hb.stop();
    await clock.advance(10_000);

    expect(ticks).toHaveLength(3);
    expect(clock.pending()).toBe(0);
  });

  // Isolates the `stopped` flag from the clearTimeout in stop(). Called from
  // outside a tick, clearTimeout alone is enough to halt the loop — so only a
  // stop() issued from *inside* onTick, while the callback that will re-arm is
  // still on the stack, can prove the flag is checked before re-arming.
  test("AC7: stop() called from inside a tick prevents the loop re-arming", async () => {
    let ticks = 0;
    let hb: Heartbeat | undefined;
    hb = track(
      startHeartbeat({
        intervalMs: 30,
        getSnapshot: () => snapshot(),
        onTick: () => {
          ticks++;
          hb?.stop();
        },
      }),
    );

    await clock.advance(300);

    expect(ticks).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  // Runs against the REAL timers: this asserts that the handle reaches
  // clearTimeout, which is precisely what the fake clock would substitute away.
  test("AC7: stop() clears the underlying timer (no leaked handle)", async () => {
    _heartbeatDeps.setTimeout = origSetTimeout;
    _heartbeatDeps.clearTimeout = origClearTimeout;

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

    await clock.advance(30);
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

    await clock.advance(90);
    // Exact, not a lower bound: a throw must cost the heartbeat no ticks at all.
    expect(calls).toBe(3);
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

    await clock.advance(90);
    // Exact, not a lower bound: a throw must cost the heartbeat no ticks at all.
    expect(calls).toBe(3);
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
