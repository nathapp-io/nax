/**
 * Tests for the `withTimerSpy` test helper.
 *
 * The helper is what the timer-leak suites (the executor kill path, the
 * heartbeat, the plugin cache, the MCP pool) assert against, so a silent bug in
 * it weakens every one of those tests without failing anything. Placed under
 * test/unit/ rather than beside the helper because `bun run test` only executes
 * test/unit, test/integration and test/ui.
 */

import { describe, expect, test } from "bun:test";
import { type TimerSpyOptions, waitForCondition, withTimerSpy } from "@test/helpers";
import { armFixtureTimer } from "./fixtures/timer-spy-origin-fixture";

describe("withTimerSpy", () => {
  test("AC-1: a timer whose handler ran is reported in armed and fired, and is not leaked", async () => {
    let ran = false;
    const { result, armed, fired, leaked } = await withTimerSpy(async () => {
      const id = setTimeout(() => {
        ran = true;
      }, 1);
      await waitForCondition(() => ran);
      return id;
    });

    expect(armed).toContain(result);
    expect(fired.has(result)).toBe(true);
    expect(leaked).toEqual([]);
  });

  test("AC-2: an armed timer that never fires and is never cleared is leaked", async () => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const { leaked } = await withTimerSpy(async () => {
      id = setTimeout(() => {}, 60_000);
    });

    expect(leaked).toHaveLength(1);
    expect(leaked[0]).toBe(id);
    clearTimeout(id);
  });

  test("AC-3: a function handler receives the extra arguments passed after the delay", async () => {
    let received: unknown[] = [];
    await withTimerSpy(async () => {
      setTimeout(
        (...args: unknown[]) => {
          received = args;
        },
        1,
        "alpha",
        42,
      );
      await waitForCondition(() => received.length > 0);
    });

    expect(received).toEqual(["alpha", 42]);
  });

  test("AC-4: a string handler is passed through unwrapped and cleared, so nothing leaks", async () => {
    // Bun's setTimeout rejects a string handler outright
    // (`TypeError: setTimeout expects a function`), so the pass-through cannot be
    // observed against the real timer. Standing in a timer function that accepts
    // one is the only way to exercise the branch: a spy that wrapped the handler
    // would hand the stand-in a function, and a spy that recorded nothing would
    // report the id as leaked.
    //
    // `Object.assign` installs the stand-in and `Reflect.apply` calls it: both
    // keep the string out of `setTimeout`'s declared signature, which has no
    // string overload (and a cast would feed the test/ cast ratchets).
    const realSetTimeout = globalThis.setTimeout;
    const handedToReal: unknown[] = [];
    let nextId = 0;
    let spyLeaked: unknown[] | undefined;

    try {
      Object.assign(globalThis, {
        setTimeout: (handler: unknown) => {
          handedToReal.push(handler);
          nextId += 1;
          return nextId;
        },
      });

      const spy = await withTimerSpy(async () => {
        const id = Reflect.apply(globalThis.setTimeout, globalThis, ["globalThis.__timerSpyNever", 60_000]);
        clearTimeout(id);
      });
      spyLeaked = spy.leaked;
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(spyLeaked).toEqual([]);
    expect(handedToReal).toEqual(["globalThis.__timerSpyNever"]);
  });

  test("AC-5: an origin filter records only timers armed from the origin's frames", async () => {
    let fixtureRan = false;
    const { result, armed } = await withTimerSpy(
      async () => {
        const fixtureId = armFixtureTimer(() => {
          fixtureRan = true;
        }, 1);
        // Armed here, in the test file: `timer-spy.test.ts` does not contain the
        // origin string, so this one must not be recorded.
        setTimeout(() => {}, 1);
        await waitForCondition(() => fixtureRan);
        return fixtureId;
      },
      { origin: "timer-spy-origin-fixture" },
    );

    expect(armed).toHaveLength(1);
    expect(armed[0]).toBe(result);
  });

  test("AC-6: a foreign timer still fires its handler under an origin filter", async () => {
    let fixtureRan = false;
    let foreignRan = false;

    await withTimerSpy(
      async () => {
        armFixtureTimer(() => {
          fixtureRan = true;
        }, 1);
        setTimeout(() => {
          foreignRan = true;
        }, 1);
        await waitForCondition(() => fixtureRan && foreignRan);
      },
      { origin: "timer-spy-origin-fixture" },
    );

    expect(foreignRan).toBe(true);
  });

  test("AC-7: with no options every timer fn arms is recorded", async () => {
    const { result, armed, cleared, leaked } = await withTimerSpy(async () => {
      const kept = setTimeout(() => {}, 60_000);
      const released = setTimeout(() => {}, 60_000);
      clearTimeout(released);
      return { kept, released };
    });

    expect(armed).toHaveLength(2);
    expect(armed[0]).toBe(result.kept);
    expect(armed[1]).toBe(result.released);
    expect(cleared.has(result.released)).toBe(true);
    expect(leaked).toHaveLength(1);
    expect(leaked[0]).toBe(result.kept);
    clearTimeout(result.kept);
  });

  test("AC-8: the helpers barrel exports withTimerSpy beside the TimerSpyOptions type", async () => {
    const options: TimerSpyOptions = {};

    const spy = await withTimerSpy(async () => "done", options);

    expect(spy.result).toBe("done");
    expect(spy.leaked).toEqual([]);
  });
});
