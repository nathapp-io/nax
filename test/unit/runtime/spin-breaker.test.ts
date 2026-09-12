import { describe, expect, test } from "bun:test";
import { createSpinBreaker, type ResolvedSpinBreakerSettings } from "@/runtime";

function settings(overrides: Partial<ResolvedSpinBreakerSettings> = {}): ResolvedSpinBreakerSettings {
  return {
    enabled: true,
    nudgeAfterRepeats: 25,
    maxNudges: 3,
    stopAfterRepeats: 50,
    recentKeyWindow: 64,
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
    const breaker = createSpinBreaker(settings());
    const actions: string[] = [];

    for (let i = 0; i < 26; i += 1) actions.push(breaker.observe("RunCommand", TEST_CMD).action);

    // Call 1 is a new key (progress). Calls 2..26 are 25 repeats, so the 26th
    // is the first to reach nudgeAfterRepeats.
    expect(actions.slice(0, 25).every((action) => action === "allow")).toBe(true);
    expect(actions[25]).toBe("nudge");
  });

  test("counts alternating shapes as repetition, which is what the incident did", () => {
    const breaker = createSpinBreaker(settings());
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
    const breaker = createSpinBreaker(settings());
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
    const breaker = createSpinBreaker(settings());

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
    const breaker = createSpinBreaker(settings());

    breaker.observe("Read", { path: "a.ts" });
    for (let i = 0; i < 30; i += 1) breaker.observe("RunCommand", TEST_CMD);

    const summary = breaker.summary();
    expect(summary.totalCalls).toBe(31);
    expect(summary.newKeyEvents).toBe(2);
    expect(summary.maxRepeatRun).toBe(29);
    expect(summary.nudges).toBe(1);
  });
});
