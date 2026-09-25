import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { agentManagerConfigSelector } from "@/config";
import {
  createSpinBreaker,
  DEFAULT_SPIN_BREAKER_SETTINGS,
  type ResolvedSpinBreakerSettings,
  type SpinVerdict,
  spinTerminalNotice,
} from "@/runtime";
import { selectSpinBreakerSettings } from "@/session/spin-breaker-selection";

/**
 * nax#2017 time axis: a repeat run with no new call must end the turn BEFORE the
 * tool-call-only idle watchdog cancels it, so the cancel is classified
 * `fail-spin` rather than `fail-stale`.
 *
 * The fixture is deliberately NOT annotated with `ResolvedSpinBreakerSettings`:
 * `stopAfterNoProgressSeconds` is added by this story, and an annotated object
 * literal carrying it would be an excess-property error before the
 * implementation lands.
 */
function settings(overrides: Partial<ResolvedSpinBreakerSettings> = {}) {
  return { ...DEFAULT_SPIN_BREAKER_SETTINGS, stopAfterNoProgressSeconds: 900, ...overrides };
}

const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };

/** A hand-driven clock: the breaker must read time from here, never from Date.now. */
function makeClock(startMs = 0) {
  let nowMs = startMs;
  return {
    now: (): number => nowMs,
    set(ms: number): void {
      nowMs = ms;
    },
  };
}

/** The call B/`fresh()` that shows the model did something new. */
function freshKey(index: number): { path: string } {
  return { path: `src/fresh-${index}.ts` };
}

describe("spin breaker — no-progress time axis", () => {
  test("DEFAULT_SPIN_BREAKER_SETTINGS enables the axis at 900 seconds", () => {
    expect(DEFAULT_SPIN_BREAKER_SETTINGS.stopAfterNoProgressSeconds).toBe(900);
  });

  // The time axis fires on repetition alone — its own nudge ladder and AC1's
  // sequence never call `noteResult` — so the model-facing terminal notice must
  // not claim an unchanged result. `observeSpin` (loop-handlers.ts) surfaces it
  // verbatim as the terminate content for the outstanding call.
  test("the 'no-progress-time' terminal notice does not claim an unchanged result", () => {
    const notice = spinTerminalNotice("no-progress-time");

    expect(notice).toContain("This turn is ending");
    expect(notice).not.toContain("no change in its result");
    // ...while the reasons that rest on result evidence keep the original copy.
    expect(spinTerminalNotice("same-key-cumulative")).toContain("no change in its result");
    expect(spinTerminalNotice("same-key-backstop")).toContain("safety call limit");
  });

  test("AC1: repeats 5-7 nudge and repeat 8 stops with 'no-progress-time' after 1,000,000 ms of no new call", () => {
    const clock = makeClock();
    const breaker = createSpinBreaker(settings(), { now: clock.now });

    expect(breaker.observe("RunCommand", KEY_A).action).toBe("allow");
    clock.set(1_000_000);
    const repeats: SpinVerdict[] = [];
    for (let i = 0; i < 8; i += 1) repeats.push(breaker.observe("RunCommand", KEY_A));

    expect(repeats.slice(0, 4).map((verdict) => verdict.action)).toEqual(["allow", "allow", "allow", "allow"]);
    expect(repeats.slice(4, 7).map((verdict) => verdict.action)).toEqual(["nudge", "nudge", "nudge"]);
    expect(repeats[7]).toMatchObject({ action: "stop", reason: "no-progress-time" });
  });

  test("AC2: no nudge or stop at 899,000 ms — the axis fires only once 900 s have elapsed", () => {
    const clock = makeClock();
    const breaker = createSpinBreaker(settings(), { now: clock.now });

    expect(breaker.observe("RunCommand", KEY_A).action).toBe("allow");
    clock.set(899_000);
    const repeats: SpinVerdict[] = [];
    for (let i = 0; i < 8; i += 1) repeats.push(breaker.observe("RunCommand", KEY_A));

    // 899,000 ms is below the 900,000 ms limit: the whole run is still allowed.
    expect(repeats.map((verdict) => verdict.action)).toEqual([
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
      "allow",
    ]);

    // The boundary is `>=`, not `>`: one second later the run is over budget
    // and the nudge ladder starts.
    clock.set(900_000);
    expect(breaker.observe("RunCommand", KEY_A).action).toBe("nudge");
  });

  test("AC3: a new key after the third repeat restarts the clock and the repeat count, so the A run does not stop there", () => {
    const clock = makeClock();
    const breaker = createSpinBreaker(settings(), { now: clock.now });

    breaker.observe("RunCommand", KEY_A);
    clock.set(1_000_000);
    for (let i = 0; i < 3; i += 1) breaker.observe("RunCommand", KEY_A);
    expect(breaker.observe("Read", freshKey(0)).action).toBe("allow");

    // Five repeats, not four: the fifth is the one that reaches
    // NO_PROGRESS_TIME_MIN_REPEATS, and it is still allowed because the new key
    // restarted the clock — had the anchor stayed at the A run's start, the
    // elapsed 1,000,000 ms would already have tripped the axis on this call.
    const repeats: SpinVerdict[] = [];
    for (let i = 0; i < 5; i += 1) repeats.push(breaker.observe("RunCommand", KEY_A));

    expect(repeats.map((verdict) => verdict.action)).toEqual(["allow", "allow", "allow", "allow", "allow"]);

    // ...and a full 900 s after the new key the run does end, so the clock was
    // re-anchored rather than the axis simply being absent.
    clock.set(1_900_000);
    expect(breaker.observe("RunCommand", KEY_A).action).toBe("nudge");
  });

  test("AC4: stopAfterNoProgressSeconds 0 disables the axis, while the same clock still trips a 900 s breaker", () => {
    const clock = makeClock();
    const disabled = createSpinBreaker(settings({ stopAfterNoProgressSeconds: 0 }), { now: clock.now });
    const control = createSpinBreaker(settings(), { now: clock.now });

    disabled.observe("RunCommand", KEY_A);
    control.observe("RunCommand", KEY_A);
    clock.set(10_000_000);

    const disabledRepeats: SpinVerdict[] = [];
    const controlRepeats: SpinVerdict[] = [];
    for (let i = 0; i < 20; i += 1) {
      disabledRepeats.push(disabled.observe("RunCommand", KEY_A));
      controlRepeats.push(control.observe("RunCommand", KEY_A));
    }

    for (const verdict of disabledRepeats) expect(verdict.action).toBe("allow");
    // The control proves 0 is what disables the axis, not the ten million ms
    // elapsed being too little to matter.
    expect(controlRepeats[4].action).toBe("nudge");
  });

  test("AC9: the watchdog-derived setting stops A with 'no-progress-time' at 601,000 ms", () => {
    const config = agentManagerConfigSelector.select(
      makeNaxConfig({
        agent: { idleWatchdog: { mode: "warn-then-cancel", toolCallOnlyIdleTimeoutSeconds: 1200 } },
      }),
    );
    const resolved = selectSpinBreakerSettings(config);
    const clock = makeClock();
    const breaker = createSpinBreaker(resolved, { now: clock.now });

    breaker.observe("RunCommand", KEY_A);
    clock.set(601_000);
    const repeats: SpinVerdict[] = [];
    for (let i = 0; i < 8; i += 1) repeats.push(breaker.observe("RunCommand", KEY_A));

    expect(resolved.stopAfterNoProgressSeconds).toBe(600);
    expect(repeats[7]).toMatchObject({ action: "stop", reason: "no-progress-time" });
  });
});
