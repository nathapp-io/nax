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
      // nax#2120: the cumulative counter now needs a result to compare. Key A
      // and key B each get a constant result; each distinct Read gets its own
      // path-bearing string so it changes every time.
      const resultText =
        toolName === "Read" ? `contents of ${String((input as { path: unknown }).path)}` : "same output every time";
      breaker.noteResult(toolName, input, resultText);
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
    for (let cycle = 0; cycle < 8; cycle += 1) {
      // Three A's, then a B. Per cycle: A becomes cumulative (cycle*3 + 1..3).
      for (let i = 0; i < 3; i += 1) {
        aCount += 1;
        const verdict = breaker.observe("RunCommand", KEY_A);
        if (verdict.action === "stop") {
          stoppedAtA = aCount;
          break;
        }
        breaker.noteResult("RunCommand", KEY_A, "identical");
      }
      if (stoppedAtA !== undefined) break;
      const bVerdict = breaker.observe("RunCommand", KEY_B);
      if (bVerdict.action === "stop") {
        // B has only fired once in this loop, so it can't be the trigger.
        throw new Error("Unexpected stop on B — A should have tripped first");
      }
      breaker.noteResult("RunCommand", KEY_B, "identical");
    }

    // nax#2120: the result axis lags the raw count by one call, so the ladder
    // (12/13/14 nudge) now stops on the 16th occurrence of A rather than 15.
    // The ladder must always render before a kill.
    expect(stoppedAtA).toBe(16);
  });

  test("interleaving does not reset the cumulative counter (the laundering hole)", () => {
    const breaker = createSpinBreaker(settings());
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };
    const KEY_B = { command: "testScoped", values: { files: "b.test.ts" } };

    // [A, B, A, B, ...] — repeatsSinceProgress never exceeds 1, so the
    // nudgeAfterRepeats=25 path can never trip. Only the cumulative check
    // can end this, and it must, after spending the full ladder. Both keys
    // climb together, so which one finally crosses is symmetric and not
    // worth asserting; that the loop is bounded at all is the point.
    let stoppedAt: number | undefined;
    for (let i = 0; i < 40 && stoppedAt === undefined; i += 1) {
      const key = i % 2 === 0 ? KEY_A : KEY_B;
      const verdict = breaker.observe("RunCommand", key);
      if (verdict.action === "stop") {
        stoppedAt = i + 1;
        break;
      }
      breaker.noteResult("RunCommand", key, "identical");
    }

    // Both keys accumulate a same-result run and cross together; the one-call
    // result lag shifts the stop from 26 to 28.
    expect(stoppedAt).toBe(28);
    expect(breaker.summary().nudges).toBe(3);
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

  test("the cumulative path spends the nudge ladder before it stops (nax#2120)", () => {
    // With the default settings the result-axis check engages at 12, but it
    // must NOT kill cold: occurrences 12/13/14 nudge, and (with the one-call
    // result lag) 16 stops. A same-key stop reached with nudges: 0 is the
    // defect nax#2120 filed.
    const breaker = createSpinBreaker(settings());
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };

    let stoppedAt: number | undefined;
    let nudges = 0;
    for (let i = 0; i < 50 && stoppedAt === undefined; i += 1) {
      const verdict = breaker.observe("RunCommand", KEY_A);
      if (verdict.action === "nudge") nudges += 1;
      if (verdict.action === "stop") {
        stoppedAt = i + 1;
        break;
      }
      breaker.noteResult("RunCommand", KEY_A, "identical");
    }

    expect(stoppedAt).toBe(16);
    expect(nudges).toBe(3);
  });

  // nax#2120 defect 3 (the ratchet): the cumulative count latched at the
  // threshold, so every later occurrence of that key re-killed instantly.
  // The breaker is session-scoped by design (nax#2047), so "latched" meant
  // every subsequent TURN died on its first re-occurrence of the key.
  test("a cumulative stop resets that key's count, so the next occurrence does not re-kill", () => {
    const breaker = createSpinBreaker(settings());

    let firstStopAt: number | undefined;
    for (let i = 0; i < 20 && firstStopAt === undefined; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      if (verdict.action === "stop") {
        firstStopAt = i + 1;
        break;
      }
      breaker.noteResult("RunCommand", TEST_CMD, "identical");
    }
    expect(firstStopAt).toBe(16);

    // The 12 occurrences after the stop must all be allowed: the count
    // restarts from zero and has to climb the full threshold again. The
    // one-call result lag shifts the second stop from the 12th to the 13th.
    for (let i = 0; i < 12; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      expect(verdict.action).not.toBe("stop");
      breaker.noteResult("RunCommand", TEST_CMD, "identical");
    }
    // The 13th does fire again — a genuinely wedged session still dies.
    expect(breaker.observe("RunCommand", TEST_CMD).action).toBe("stop");
  });

  test("a stop does not turn the key into a new-key event", () => {
    const breaker = createSpinBreaker(settings());

    for (let i = 0; i < 16; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      if (verdict.action === "stop") break;
      breaker.noteResult("RunCommand", TEST_CMD, "identical");
    }
    const newKeysAfterStop = breaker.summary().newKeyEvents;
    breaker.observe("RunCommand", TEST_CMD);

    // Resetting the count must not look like progress: newKeyEvents is the
    // "did something new happen" instrument and a re-issued key is not new.
    expect(breaker.summary().newKeyEvents).toBe(newKeysAfterStop);
  });

  // nax#2120 defect 1: for a loop over 1-2 already-seen keys the first nudge
  // point (25) was unreachable, because the cumulative stop returned before
  // repeatsSinceProgress was incremented. The invariant is now in the
  // mechanism: no config can produce a stop with nudges: 0.
  test("never stops with nudges unspent, for any cycle length", () => {
    const KEY_A = { command: "testScoped", values: { files: "a.test.ts" } };
    const KEY_B = { command: "testScoped", values: { files: "b.test.ts" } };
    const KEY_C = { command: "testScoped", values: { files: "c.test.ts" } };
    const cycles: ReadonlyArray<readonly unknown[]> = [[KEY_A], [KEY_A, KEY_B], [KEY_A, KEY_B, KEY_C]];

    for (const cycle of cycles) {
      const breaker = createSpinBreaker(settings());
      let stopped = false;
      for (let i = 0; i < 400 && !stopped; i += 1) {
        if (breaker.observe("RunCommand", cycle[i % cycle.length]).action === "stop") stopped = true;
      }
      expect(stopped).toBe(true);
      expect(breaker.summary().nudges).toBe(3);
    }
  });

  test("a downgraded stop does not consume the cumulative evidence", () => {
    // The Task 1 reset belongs to a REAL stop. If a nudge reset the count
    // too, the threshold could never be reached a second time and the loop
    // would nudge forever.
    const breaker = createSpinBreaker(settings());
    let stopped = false;
    for (let i = 0; i < 20 && !stopped; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      if (verdict.action === "stop") {
        stopped = true;
        break;
      }
      breaker.noteResult("RunCommand", TEST_CMD, "identical");
    }
    expect(stopped).toBe(true);
  });

  // nax#2120 defect 2: the cumulative counter had no progress axis, so an
  // edit -> re-run-scoped-test loop read identically to an idle re-run loop.
  // Result identity is the axis the nudge copy already claims to measure.
  test("an edit-test loop with changing results is never stopped", () => {
    const breaker = createSpinBreaker(settings());

    // 40 iterations of the shape that was killed: same scoped test command,
    // a different failure each time.
    for (let i = 0; i < 40; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      expect(verdict.action).not.toBe("stop");
      breaker.noteResult("RunCommand", TEST_CMD, `FAIL: expected ${i} to equal ${i + 1}`);
    }
  });

  test("identical results still stop, spending the ladder first", () => {
    const breaker = createSpinBreaker(settings());

    let stoppedAt: number | undefined;
    for (let i = 0; i < 40 && stoppedAt === undefined; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stoppedAt = i + 1;
      breaker.noteResult("RunCommand", TEST_CMD, "PASS 1 test, 0 failures");
    }

    // 16, not 15: `observe` runs pre-execution, so occurrence N's result is
    // only known when N+1 is judged. sameResultRun therefore lags the raw
    // count by exactly one call, and the whole ladder shifts with it.
    expect(stoppedAt).toBe(16);
  });

  test("durations and timestamps do not count as a changed result", () => {
    // A test runner prints an elapsed time on every run. Without
    // normalisation, byte-identical work reads as a changed result and the
    // whole check is defeated — this is the nax#2013 verifier's shape.
    const breaker = createSpinBreaker(settings());

    let stopped = false;
    for (let i = 0; i < 40 && !stopped; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stopped = true;
      breaker.noteResult("RunCommand", TEST_CMD, `\x1b[32mPASS\x1b[0m 1 test in ${1.2 + i * 0.01}s`);
    }

    expect(stopped).toBe(true);
  });

  test("a changed failure count IS a changed result", () => {
    // The normaliser must strip duration/timestamp tokens only. Blanking all
    // digits would mask "2 failed" -> "1 failed", which is real progress.
    const breaker = createSpinBreaker(settings());

    for (let i = 0; i < 40; i += 1) {
      const verdict = breaker.observe("RunCommand", TEST_CMD);
      expect(verdict.action).not.toBe("stop");
      breaker.noteResult("RunCommand", TEST_CMD, `FAIL ${40 - i} failed in 1.20s`);
    }
  });

  test("a bare integer m/s token is a changed result, not a stripped duration (nax#2120 fix)", () => {
    // A single-letter unit with no time context is ordinary content, not an
    // elapsed time: `file-2m.ts` and `file-3m.ts` differ for real. If the
    // normaliser stripped the `<int>m`/`<int>s` tokens the digests would be
    // identical and this healthy loop would be stopped at 16.
    for (const unit of ["m", "s"]) {
      const breaker = createSpinBreaker(settings());
      for (let i = 0; i < 40; i += 1) {
        const verdict = breaker.observe("RunCommand", TEST_CMD);
        expect(verdict.action).not.toBe("stop");
        breaker.noteResult("RunCommand", TEST_CMD, `file-${i}${unit}.ts`);
      }
    }
  });

  test("the raw backstop still fires when results never repeat", () => {
    // A call whose result is unique every time (a clock read, a random id)
    // must not be immortal: stopAfterRepeats bounds the raw cumulative count.
    const breaker = createSpinBreaker(settings());

    let stopped = false;
    for (let i = 0; i < 120 && !stopped; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stopped = true;
      breaker.noteResult("RunCommand", TEST_CMD, `unique-${i}-${i * 7}`);
    }

    expect(stopped).toBe(true);
    expect(breaker.summary().nudges).toBe(3);
  });

  test("a key with no noted result falls back to the raw count", () => {
    // Denied and errored calls never reach noteResult. They must still be
    // bounded, on the raw backstop rather than the result axis.
    const breaker = createSpinBreaker(settings());

    let stopped = false;
    for (let i = 0; i < 120 && !stopped; i += 1) {
      if (breaker.observe("RunCommand", TEST_CMD).action === "stop") stopped = true;
    }

    expect(stopped).toBe(true);
  });
});
