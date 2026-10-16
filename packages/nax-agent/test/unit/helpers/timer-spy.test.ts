import { describe, expect, test } from "bun:test";
import { type TimerSpyOptions, waitForCondition, withTimerSpy } from "#test/helpers/index";
import { armFixtureTimer } from "./fixtures/timer-spy-origin-fixture";

describe("withTimerSpy", () => {
  test("records armed and cleared timers; a cleared timer is not leaked", async () => {
    const spy = await withTimerSpy(async () => {
      const id = setTimeout(() => {}, 60_000);
      clearTimeout(id);
      return "done";
    });
    expect(spy.result).toBe("done");
    expect(spy.armed).toHaveLength(1);
    expect(spy.leaked).toEqual([]);
  });

  test("reports an armed-but-never-cleared timer as leaked", async () => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const spy = await withTimerSpy(async () => {
      id = setTimeout(() => {}, 60_000);
      return 1;
    });
    expect(spy.leaked).toEqual(spy.armed);
    clearTimeout(id);
  });

  test("AC-2: an armed timer that never fires and is never cleared is reported in leaked", async () => {
    let id: ReturnType<typeof setTimeout> | undefined;
    const { armed, fired, leaked } = await withTimerSpy(async () => {
      id = setTimeout(() => {}, 60_000);
      return id;
    });

    expect(armed).toContain(id);
    // The fired-timer exclusion must not swallow a timer that never fired.
    expect(fired.has(id)).toBe(false);
    expect(leaked).toContain(id);
    clearTimeout(id);
  });

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

  test("AC-3: a function handler receives the extra arguments passed after the delay", async () => {
    let received: unknown[] = [];
    let id: ReturnType<typeof setTimeout> | undefined;
    const { fired } = await withTimerSpy(async () => {
      id = setTimeout(
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
    // The wrapper this story introduces is the only thing that records a timer
    // as fired, so this pins that it forwards the extra arguments instead of
    // dropping them on the way to the handler.
    expect(fired.has(id)).toBe(true);
  });

  test("AC-4: a string handler is passed through unwrapped and cleared, so nothing leaks", async () => {
    // Bun's setTimeout rejects a string handler outright
    // (`TypeError: setTimeout expects a function`), so the pass-through cannot be
    // observed against the real timer. Standing in a timer function that accepts
    // one is the only way to exercise the branch: a spy that wrapped the handler
    // would hand the stand-in a function, and a spy that recorded nothing would
    // drop the id before it could be leaked.
    //
    // `Object.assign` installs the stand-in and `Reflect.apply` calls it: both
    // keep the string out of `setTimeout`'s declared signature, which has no
    // string overload (and a cast would feed the test/ cast ratchets).
    const realSetTimeout = globalThis.setTimeout;
    const handedToReal: unknown[] = [];
    let nextId = 0;
    let clearedId: unknown;
    let leaked: unknown[] | undefined;
    let fired: Set<unknown> | undefined;

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
        return id;
      });
      clearedId = spy.result;
      leaked = spy.leaked;
      fired = spy.fired;
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    expect(leaked).toEqual([]);
    // The handler reached the real timer function as the string it was given —
    // unwrapped — rather than as a spy wrapper.
    expect(handedToReal).toEqual(["globalThis.__timerSpyNever"]);
    // Nothing wrapped it, so nothing could mark it fired.
    expect(fired?.has(clearedId)).toBe(false);
  });

  test("AC-5: an origin filter records only timers armed from the origin's frames", async () => {
    let fixtureRan = false;
    let foreignRan = false;

    const { result, armed } = await withTimerSpy(
      async () => {
        // Armed from `timer-spy-origin-fixture.ts`: its frames carry the origin.
        const fixtureId = armFixtureTimer(() => {
          fixtureRan = true;
        }, 1);
        // Armed here, in the test file: `timer-spy.test.ts` does not contain the
        // origin string, so this one must not be recorded.
        const foreignId = setTimeout(() => {
          foreignRan = true;
        }, 1);
        await waitForCondition(() => fixtureRan && foreignRan);
        return { fixtureId, foreignId };
      },
      { origin: "timer-spy-origin-fixture" },
    );

    expect(armed).toHaveLength(1);
    expect(armed[0]).toBe(result.fixtureId);
    expect(armed).not.toContain(result.foreignId);
    // The filter records nothing for a foreign timer but still arms it: the
    // handler ran, so the real setTimeout received it.
    expect(foreignRan).toBe(true);
  });

  test("AC-6: the helpers barrel exports withTimerSpy beside the TimerSpyOptions type", async () => {
    const options: TimerSpyOptions = {};

    const spy = await withTimerSpy(async () => "done", options);

    expect(spy.result).toBe("done");
    expect(spy.leaked).toEqual([]);
  });
});
