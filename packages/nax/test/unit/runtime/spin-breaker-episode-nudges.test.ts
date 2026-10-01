import { describe, expect, test } from "bun:test";
import {
  createSpinBreaker,
  DEFAULT_SPIN_BREAKER_SETTINGS,
  type SpinBreaker,
  type SpinStopReason,
  type SpinVerdict,
} from "@/runtime";

/**
 * nax#2017 per-episode nudge budget: `nudges` stays the session-cumulative count
 * `summary()` reports, while a separate per-episode counter is what the nudge
 * points spend against `maxNudges`. It is restored by sustained NEW work (a
 * fresh key is not enough) and consumed by a real stop.
 *
 * Every clock here is frozen at 0 so the no-progress TIME axis stays inert and
 * these tests measure the budget axis alone.
 */
const FROZEN_CLOCK = { now: (): number => 0 };

const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };
const KEY_B = { command: "testScoped", values: { files: "b.test.ts" } };

function freshKey(index: number): { path: string } {
  return { path: `src/fresh-${index}.ts` };
}

/**
 * [A, A, never-before-seen-key] forever, each call followed by an unchanged
 * result. The fresh key between every two A repetitions resets the run counter
 * but must NOT top the nudge budget back up — a laundering loop would otherwise
 * never stop (nax#2047).
 */
function driveFreshKeyBetweenRepeats(breaker: SpinBreaker): SpinStopReason | undefined {
  for (let fresh = 0; fresh < 20; fresh += 1) {
    const cycle: ReadonlyArray<{ toolName: string; input: unknown }> = [
      { toolName: "RunCommand", input: KEY_A },
      { toolName: "RunCommand", input: KEY_A },
      { toolName: "Read", input: freshKey(fresh) },
    ];
    for (const call of cycle) {
      const verdict = breaker.observe(call.toolName, call.input);
      if (verdict.action === "stop") return verdict.reason;
      breaker.noteResult(call.toolName, call.input, "identical");
    }
  }
  return undefined;
}

/**
 * A (1 call) + 42 repeats of A -> the three default nudge points 25/33/42 are
 * spent; then 25 distinct new keys -> the budget is replenished; then 25 repeats
 * of the last new key -> its 25th repeat sits exactly on the first nudge point.
 */
function driveSpentThenReplenishedBudget(): { breaker: SpinBreaker; lastRepeat: SpinVerdict | undefined } {
  const breaker = createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS, FROZEN_CLOCK);

  breaker.observe("RunCommand", KEY_A);
  for (let i = 0; i < 42; i += 1) breaker.observe("RunCommand", KEY_A);
  for (let i = 0; i < 25; i += 1) breaker.observe("Read", freshKey(i));

  const lastKey = freshKey(24);
  let lastRepeat: SpinVerdict | undefined;
  for (let i = 0; i < 25; i += 1) lastRepeat = breaker.observe("Read", lastKey);

  return { breaker, lastRepeat };
}

describe("spin breaker — per-episode nudge budget", () => {
  test("AC12: the [A, B] laundering loop still stops at call 28 with 3 nudges", () => {
    const breaker = createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS, FROZEN_CLOCK);

    let stoppedAt: number | undefined;
    for (let i = 0; i < 40 && stoppedAt === undefined; i += 1) {
      const key = i % 2 === 0 ? KEY_A : KEY_B;
      if (breaker.observe("RunCommand", key).action === "stop") {
        stoppedAt = i + 1;
        break;
      }
      breaker.noteResult("RunCommand", key, "identical");
    }

    expect(stoppedAt).toBe(28);
    expect(breaker.summary().nudges).toBe(3);
  });

  test("AC13: a fresh key between every two A repeats still ends in a 'same-key-cumulative' stop", () => {
    const breaker = createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS, FROZEN_CLOCK);

    expect(driveFreshKeyBetweenRepeats(breaker)).toBe("same-key-cumulative");
  });

  test("AC14: the budget is 3 at that stop — a fresh interleaved key does not restore it", () => {
    const breaker = createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS, FROZEN_CLOCK);

    const reason = driveFreshKeyBetweenRepeats(breaker);

    expect(reason).toBe("same-key-cumulative");
    expect(breaker.summary().nudges).toBe(3);
  });

  test("AC15: after 25 distinct new keys, the last key's 25th repeat nudges with nudgeNumber 1", () => {
    const { lastRepeat } = driveSpentThenReplenishedBudget();

    expect(lastRepeat).toMatchObject({ action: "nudge", nudgeNumber: 1 });
  });

  test("AC16: summary().nudges still reports the session-cumulative 4 after that replenished nudge", () => {
    const { breaker } = driveSpentThenReplenishedBudget();

    expect(breaker.summary().nudges).toBe(4);
  });

  test("AC17: after a real stop, a different key's repeat run nudges instead of stopping again", () => {
    const breaker = createSpinBreaker(DEFAULT_SPIN_BREAKER_SETTINGS, FROZEN_CLOCK);

    let stopped = false;
    for (let i = 0; i < 60 && !stopped; i += 1) {
      stopped = breaker.observe("RunCommand", KEY_A).action === "stop";
    }
    expect(stopped).toBe(true);

    let verdict: SpinVerdict | undefined;
    for (let i = 0; i < 40 && verdict === undefined; i += 1) {
      const observed = breaker.observe("RunCommand", KEY_B);
      if (observed.action !== "allow") verdict = observed;
    }

    expect(verdict ?? { action: "none" }).toMatchObject({ action: "nudge", nudgeNumber: 1 });
  });
});
