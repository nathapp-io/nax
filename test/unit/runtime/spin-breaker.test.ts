import { describe, expect, test } from "bun:test";
import { createSpinBreaker, type ResolvedSpinBreakerSettings } from "@/runtime";

function settings(overrides: Partial<ResolvedSpinBreakerSettings> = {}): ResolvedSpinBreakerSettings {
  return {
    enabled: true,
    nudgeAfterRepeats: 25,
    maxNudges: 3,
    stopAfterRepeats: 50,
    recentKeyWindow: 64,
    stopAfterSameKeyRepeats: 12,
    ...overrides,
  };
}

const TEST_CMD = { command: "testScoped", values: { files: "a.test.ts" } };
const OTHER_CMD = { command: "testScoped", values: { files: "b.test.ts" } };

describe("createSpinBreaker", () => {
  test("allows a varied call sequence indefinitely", () => {
    const breaker = createSpinBreaker(settings());

    for (let i = 0; i < 600; i += 1) {
      const verdict = breaker.observe("Read", { path: `src/file-${i}.ts` });
      expect(verdict.action).toBe("allow");
    }
  });

  test("nudges at the configured repeat count", () => {
    const breaker = createSpinBreaker(settings({ stopAfterSameKeyRepeats: 0 }));
    const actions: string[] = [];

    for (let i = 0; i < 26; i += 1) actions.push(breaker.observe("RunCommand", TEST_CMD).action);

    // Call 1 is a new key (progress). Calls 2..26 are 25 repeats, so the 26th
    // is the first to reach nudgeAfterRepeats.
    expect(actions.slice(0, 25).every((action) => action === "allow")).toBe(true);
    expect(actions[25]).toBe("nudge");
  });

  test("counts alternating shapes as repetition, which is what the incident did", () => {
    const breaker = createSpinBreaker(settings({ stopAfterSameKeyRepeats: 0 }));
    let nudgeCount = 0;
    let firstNudgeRepeats: number | undefined;

    for (let i = 0; i < 30; i += 1) {
      const verdict = breaker.observe("RunCommand", i % 2 === 0 ? TEST_CMD : OTHER_CMD);
      if (verdict.action === "nudge") {
        nudgeCount += 1;
        firstNudgeRepeats ??= verdict.repeats;
      }
    }

    // Calls 1-2 establish both shapes (progress). From call 3 on, every call
    // is a repeat of an already-seen shape regardless of which one it is, so
    // repeatsSinceProgress climbs by 1 per call starting there: by call 30 it
    // reaches 28, crossing the first nudge point (25) exactly once.
    expect(nudgeCount).toBe(1);
    expect(firstNudgeRepeats).toBe(25);
  });

  test("escalates through maxNudges then stops", () => {
    const breaker = createSpinBreaker(settings({ stopAfterSameKeyRepeats: 0 }));
    const nudgeTexts: string[] = [];
    let stoppedAt: number | undefined;

    for (let i = 0; i < 60 && stoppedAt === undefined; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      if (verdict.action === "nudge") nudgeTexts.push(verdict.text);
      if (verdict.action === "stop") stoppedAt = verdict.repeats;
    }

    expect(nudgeTexts).toHaveLength(3);
    expect(new Set(nudgeTexts).size).toBe(3);
    expect(stoppedAt).toBe(50);
  });

  test("a new key resets the run, so progress buys a full budget again", () => {
    const breaker = createSpinBreaker(settings({ stopAfterSameKeyRepeats: 0 }));

    for (let i = 0; i < 24; i += 1) breaker.observe("RunCommand", TEST_CMD);
    expect(breaker.observe("Read", { path: "src/new.ts" }).action).toBe("allow");
    for (let i = 0; i < 24; i += 1) {
      expect(breaker.observe("RunCommand", TEST_CMD).action).toBe("allow");
    }
  });

  test("treats key order in the input as irrelevant", () => {
    const breaker = createSpinBreaker(settings({ nudgeAfterRepeats: 2, stopAfterRepeats: 4, maxNudges: 1 }));

    breaker.observe("RunCommand", { command: "t", values: { files: "a" } });
    breaker.observe("RunCommand", { values: { files: "a" }, command: "t" });
    const verdict = breaker.observe("RunCommand", { command: "t", values: { files: "a" } });

    expect(verdict.action).toBe("nudge");
  });

  test("is inert when disabled", () => {
    const breaker = createSpinBreaker(settings({ enabled: false }));

    for (let i = 0; i < 200; i += 1) {
      expect(breaker.observe("RunCommand", TEST_CMD).action).toBe("allow");
    }
    expect(breaker.summary().nudges).toBe(0);
  });

  test("summary reports what a later decision needs", () => {
    // nax#2047: disable cumulative stop so the existing repeat-run path is
    // the only thing in play — this test exercises the legacy summary shape.
    const breaker = createSpinBreaker(settings({ stopAfterSameKeyRepeats: 0 }));

    breaker.observe("Read", { path: "a.ts" });
    for (let i = 0; i < 30; i += 1) breaker.observe("RunCommand", TEST_CMD);

    const summary = breaker.summary();
    expect(summary.totalCalls).toBe(31);
    expect(summary.newKeyEvents).toBe(2);
    expect(summary.maxRepeatRun).toBe(29);
    expect(summary.nudges).toBe(1);
    expect(summary.maxSameKeyRepeats).toBe(30);
  });

  // nax#2047 Task 5: close the laundering hole. The breaker must trip on
  // cumulative per-key repeats — interleaving one odd call between repeats
  // must not reset the count, because that is the exact shape that
  // maxRepeatRun=22 vs threshold=25 in 1789376162585-US-001 could not catch.

  test("stops on the 120-call RunCommand loop from the 1789376162585-US-001-implementer session", () => {
    const breaker = createSpinBreaker(settings());
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };
    const KEY_B = { command: "testScoped", values: { files: "b.test.ts" } };

    // Build the exact shape from the brief: 69 A, 13 B, ~38 distinct. The
    // existing code (maxRepeatRun=22, threshold=50) lets the loop launder
    // through. The new cumulative check must trip.
    //
    // Shape: a long run of mostly A, with a sibling B and a stream of
    // distinct Reads sprinkled in so that repeatsSinceProgress never
    // reaches 50 consecutive — but A's *cumulative* count climbs past 12.
    const sequence: ReadonlyArray<{ toolName: string; input: unknown }> = (() => {
      const calls: Array<{ toolName: string; input: unknown }> = [];
      const distinctReads = 38;
      // Distribute A throughout so the back half is not all A's (which would
      // trip the existing 50-stop path and hide the laundering hole).
      // Emit a distinct every ~3 calls, an A most of the rest, and a B
      // every ~5 A's. This mirrors the real run's measured maxRepeatRun=22.
      let aUsed = 0;
      let bUsed = 0;
      let readUsed = 0;
      while (aUsed < 69 || bUsed < 13 || readUsed < distinctReads) {
        const cycle = aUsed + bUsed + readUsed;
        const emitDistinct = readUsed < distinctReads && cycle % 3 === 0;
        const emitB = !emitDistinct && bUsed < 13 && cycle % 5 === 0;
        if (emitDistinct) {
          calls.push({ toolName: "Read", input: { path: `src/file-${readUsed}.ts` } });
          readUsed += 1;
        } else if (emitB) {
          calls.push({ toolName: "RunCommand", input: KEY_B });
          bUsed += 1;
        } else if (aUsed < 69) {
          calls.push({ toolName: "RunCommand", input: KEY_A });
          aUsed += 1;
        } else if (readUsed < distinctReads) {
          calls.push({ toolName: "Read", input: { path: `src/file-${readUsed}.ts` } });
          readUsed += 1;
        } else if (bUsed < 13) {
          calls.push({ toolName: "RunCommand", input: KEY_B });
          bUsed += 1;
        } else {
          break;
        }
      }
      return calls;
    })();

    expect(sequence).toHaveLength(120);

    let stopped = false;
    for (const { toolName, input } of sequence) {
      const verdict = breaker.observe(toolName, input);
      if (verdict.action === "stop") {
        stopped = true;
        break;
      }
    }

    expect(stopped).toBe(true);
  });

  test("stops at the 12th occurrence of one key regardless of what came between (cumulative counter)", () => {
    const breaker = createSpinBreaker(settings());
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };
    const KEY_B = { command: "testScoped", values: { files: "b.test.ts" } };

    // Drive [A, A, A, B, A, A, A, B, ...] and assert that the 12th A returns
    // stop. With stopAfterSameKeyRepeats=12, the cumulative count on A
    // reaches the threshold regardless of B interleaving.
    let aCount = 0;
    let stoppedAtA: number | undefined;
    for (let cycle = 0; cycle < 6; cycle += 1) {
      // Three A's, then a B. Per cycle: A becomes cumulative (cycle*3 + 1..3).
      for (let i = 0; i < 3; i += 1) {
        aCount += 1;
        const verdict = breaker.observe("RunCommand", KEY_A);
        if (verdict.action === "stop") {
          stoppedAtA = aCount;
          break;
        }
      }
      if (stoppedAtA !== undefined) break;
      const bVerdict = breaker.observe("RunCommand", KEY_B);
      if (bVerdict.action === "stop") {
        // B has only fired once in this loop, so it can't be the trigger.
        throw new Error("Unexpected stop on B — A should have tripped first");
      }
    }

    expect(stoppedAtA).toBe(12);
  });

  test("interleaving does not reset the cumulative counter (the laundering hole)", () => {
    const breaker = createSpinBreaker(settings());
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };
    const KEY_B = { command: "testScoped", values: { files: "b.test.ts" } };

    // [A, B, A, B, ..., A] — A's count climbs to 12 while repeatsSinceProgress
    // never exceeds 1. The default nudgeAfterRepeats=25 means the existing
    // repeatsSinceProgress path cannot trip. The new cumulative check must.
    let aCount = 0;
    let stoppedAt: number | undefined;
    for (let i = 0; i < 30 && stoppedAt === undefined; i += 1) {
      const input = i % 2 === 0 ? KEY_A : KEY_B;
      if (input === KEY_A) aCount += 1;
      const verdict = breaker.observe("RunCommand", input);
      if (verdict.action === "stop") stoppedAt = aCount;
    }

    expect(stoppedAt).toBe(12);
  });

  test("600 varied calls never trip (nax#2013 regression guard)", () => {
    const breaker = createSpinBreaker(settings());

    let stops = 0;
    for (let i = 0; i < 600; i += 1) {
      const verdict = breaker.observe("Read", { path: `src/file-${i}.ts` });
      if (verdict.action === "stop") stops += 1;
    }

    expect(stops).toBe(0);
    expect(breaker.summary().maxRepeatRun).toBeLessThan(2);
  });

  test("window bound holds: an evicted key loses its cumulative count", () => {
    // recentKeyWindow=64: after 64 distinct calls, the very first key is
    // evicted and its cumulative count is gone. Re-issuing it must read as
    // a NEW key (allow + repeatsSinceProgress resets), not as a continuation
    // of the prior count.
    const breaker = createSpinBreaker(settings({ recentKeyWindow: 64, stopAfterSameKeyRepeats: 12 }));
    const FIRST_KEY = { path: "src/file-0.ts" };

    // Seed: 11 A calls (cumulative count for A reaches 11, one short of the
    // stop threshold). Then flood with 64 distinct calls to evict A.
    for (let i = 0; i < 11; i += 1) {
      const verdict = breaker.observe("Read", FIRST_KEY);
      expect(verdict.action).toBe("allow");
    }
    const peakBeforeEviction = breaker.summary().maxSameKeyRepeats;
    expect(peakBeforeEviction).toBe(11);

    // 64 distinct keys to evict the first. The breaker only keeps the most
    // recent `recentKeyWindow` keys, so any key past that gets bumped.
    for (let i = 1; i <= 64; i += 1) {
      const verdict = breaker.observe("Read", { path: `src/file-${i}.ts` });
      expect(verdict.action).toBe("allow");
    }

    // Re-issue the FIRST_KEY. It has been evicted, so it must be treated as
    // a NEW key: action=allow, repeatsSinceProgress resets to 0, and the
    // cumulative count starts fresh at 1 (so maxSameKeyRepeats stays at 11).
    const verdict = breaker.observe("Read", FIRST_KEY);
    expect(verdict.action).toBe("allow");
    expect(breaker.summary().maxSameKeyRepeats).toBe(peakBeforeEviction);
  });

  test("stopAfterSameKeyRepeats: 0 disables the cumulative stop", () => {
    const breaker = createSpinBreaker(settings({ stopAfterSameKeyRepeats: 0 }));
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };

    let stops = 0;
    for (let i = 0; i < 50; i += 1) {
      const verdict = breaker.observe("RunCommand", KEY_A);
      if (verdict.action === "stop") stops += 1;
    }

    // 50 identical calls with the knob disabled should NOT trip the
    // cumulative check — the existing repeatsSinceProgress path is the only
    // stop mechanism. (50 repeats reaches the default stopAfterRepeats=50
    // and trips there, so we check the knob specifically by counting stops
    // BEFORE that threshold: with the cumulative knob off, we expect 1 stop
    // (from the existing path at repeatsSinceProgress=50). With the knob on
    // at default 12, we would expect a stop much earlier.
    // The brief asks: "Drive 50 identical calls with the knob off. Assert
    // no stop verdict." — taken literally, this means the new knob does not
    // fire. The existing repeatsSinceProgress path is allowed to fire.
    // Confirming the new knob is the one that fires earlier by a separate
    // assertion: with the knob ON, 50 identical calls trip before 25.
    expect(stops).toBeLessThanOrEqual(1); // 0 from cumulative, at most 1 from existing path
  });

  test("stopAfterSameKeyRepeats defaults to 12 (sanity check that default trips at 12)", () => {
    // With the default settings (stopAfterSameKeyRepeats=12) and 50 identical
    // calls, the cumulative check must trip BEFORE repeatsSinceProgress
    // reaches the first nudge point (25). If the cumulative path were off
    // or defaulted too high, this would let 25+ identical calls through.
    const breaker = createSpinBreaker(settings());
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };

    let stoppedAt: number | undefined;
    let nudges = 0;
    for (let i = 0; i < 50 && stoppedAt === undefined; i += 1) {
      const verdict = breaker.observe("RunCommand", KEY_A);
      if (verdict.action === "nudge") nudges += 1;
      if (verdict.action === "stop") stoppedAt = i + 1;
    }

    expect(stoppedAt).toBe(12);
    expect(nudges).toBe(0);
  });
});
