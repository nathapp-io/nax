/**
 * Tests for the FakeClock test helper.
 *
 * The helper is what the timer-driven suites (heartbeat, idle-watchdog) assert
 * against, so a silent bug here would weaken every one of those tests without
 * failing anything. Placed under test/unit/ rather than beside the helper
 * because `bun run test` only executes test/unit, test/integration and test/ui.
 */

import { describe, expect, test } from "bun:test";
import { makeFakeClock } from "@test/helpers";

describe("makeFakeClock", () => {
  test("does not fire a timer before its deadline", async () => {
    const clock = makeFakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("t"), 100);

    await clock.advance(99);

    expect(fired).toEqual([]);
  });

  test("fires a timer exactly at its deadline", async () => {
    const clock = makeFakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("t"), 100);

    await clock.advance(100);

    expect(fired).toEqual(["t"]);
  });

  test("fires timers in deadline order, not insertion order", async () => {
    const clock = makeFakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("late"), 200);
    clock.setTimeout(() => fired.push("early"), 50);

    await clock.advance(500);

    expect(fired).toEqual(["early", "late"]);
  });

  test("breaks deadline ties in insertion order, as real timers do", async () => {
    const clock = makeFakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("first"), 10);
    clock.setTimeout(() => fired.push("second"), 10);

    await clock.advance(10);

    expect(fired).toEqual(["first", "second"]);
  });

  test("advances now() to the target even when no timer fires", async () => {
    const clock = makeFakeClock();
    const start = clock.now();

    await clock.advance(1234);

    expect(clock.now() - start).toBe(1234);
  });

  test("a callback observes now() at its own deadline, not the window's end", async () => {
    const clock = makeFakeClock();
    const start = clock.now();
    let observed = -1;
    clock.setTimeout(() => {
      observed = clock.now();
    }, 30);

    await clock.advance(500);

    expect(observed - start).toBe(30);
  });

  test("runs a self-re-arming timer once per interval in the window", async () => {
    const clock = makeFakeClock();
    let ticks = 0;
    const arm = () => {
      clock.setTimeout(() => {
        ticks++;
        arm();
      }, 100);
    };
    arm();

    await clock.advance(350);

    expect(ticks).toBe(3);
  });

  test("clearTimeout stops a pending timer", async () => {
    const clock = makeFakeClock();
    const fired: string[] = [];
    const id = clock.setTimeout(() => fired.push("t"), 100);

    clock.clearTimeout(id);
    await clock.advance(500);

    expect(fired).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("clearTimeout tolerates undefined and unknown ids", () => {
    const clock = makeFakeClock();

    expect(() => clock.clearTimeout(undefined)).not.toThrow();
    expect(() => clock.clearTimeout(9999)).not.toThrow();
  });

  test("pending() reports armed timers so tests can assert no leak", async () => {
    const clock = makeFakeClock();
    clock.setTimeout(() => {}, 100);
    clock.setTimeout(() => {}, 200);
    expect(clock.pending()).toBe(2);

    await clock.advance(150);

    expect(clock.pending()).toBe(1);
  });

  test("settles an async callback before firing the next timer", async () => {
    const clock = makeFakeClock();
    const order: string[] = [];
    // biome-ignore lint/nursery/noMisusedPromises: passing an async callback to the `() => void` slot is exactly what this test exercises — that advance() drains its microtasks
    clock.setTimeout(async () => {
      order.push("a:start");
      await Promise.resolve();
      order.push("a:end");
    }, 10);
    clock.setTimeout(() => order.push("b"), 20);

    await clock.advance(50);

    expect(order).toEqual(["a:start", "a:end", "b"]);
  });

  test("a zero-delay timer fires on the next advance", async () => {
    const clock = makeFakeClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("t"), 0);

    await clock.advance(0);

    expect(fired).toEqual(["t"]);
  });

  test("throws a diagnostic rather than hanging on a zero-delay re-arm loop", async () => {
    const clock = makeFakeClock();
    const arm = () => {
      clock.setTimeout(() => arm(), 0);
    };
    arm();

    await expect(clock.advance(10)).rejects.toThrow(/re-arming itself/);
  });
});
