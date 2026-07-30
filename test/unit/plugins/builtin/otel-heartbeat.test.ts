import { afterEach, describe, expect, test } from "bun:test";
import { withTimerSpy } from "@test/helpers";
import { type Heartbeat, type HeartbeatSnapshot, startHeartbeat } from "../../../../src/plugins/builtin/otel-reporter/heartbeat";

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
});
