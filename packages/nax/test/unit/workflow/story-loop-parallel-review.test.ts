import { expect, test } from "bun:test";
import { runStoryLoop } from "@/workflow/story-loop";
import { failingReview, makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import { newStoryRecord } from "@/workflow/result";

test("first review starts beside the pending suite with only pre-suite gates", async () => {
  let releaseSuite: (value: typeof storyLoopFixtures.SUITE_GREEN) => void = () => {};
  const suite = new Promise<typeof storyLoopFixtures.SUITE_GREEN>((resolve) => {
    releaseSuite = resolve;
  });
  let reviewCalled = false;
  let suiteCalls = 0;
  let reviewCalls = 0;
  let reviewArgs: unknown[] = [];
  let notify: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const h = makeStoryLoopHarness(
    {},
    {
      steps: {
        fullSuite: async () => {
          suiteCalls++;
          notify();
          return suite;
        },
        storyReview: async (...args) => {
          reviewCalled = true;
          reviewCalls++;
          reviewArgs = args;
          return { ran: true, verdict: storyLoopFixtures.PASS };
        },
      },
    },
  );
  const running = runStoryLoop({ ...h.env, parallelReview: true });
  await started;
  await Promise.resolve();
  expect(reviewCalled).toBe(true);
  expect(reviewArgs[2]).toEqual({ suiteRunning: true });
  expect(reviewArgs[1]).not.toHaveProperty("full-suite");
  releaseSuite(storyLoopFixtures.SUITE_GREEN);
  expect((await running).state).toBe("complete");
  expect(suiteCalls).toBe(1);
  expect(reviewCalls).toBe(1);
});

test.each(["default", "resume"])("%s review waits for suite", async (mode) => {
  let release: (value: typeof storyLoopFixtures.SUITE_GREEN) => void = () => {};
  let started: () => void = () => {};
  const pending = new Promise<typeof storyLoopFixtures.SUITE_GREEN>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const h = makeStoryLoopHarness(
    {},
    {
      resume: mode === "resume" ? newStoryRecord("x", 5, "t") : null,
      steps: {
        fullSuite: async () => {
          started();
          return pending;
        },
        storyReview: async () => {
          calls++;
          return { ran: true, verdict: storyLoopFixtures.PASS };
        },
      },
    },
  );
  const running = runStoryLoop({ ...h.env, parallelReview: mode === "resume" });
  await entered;
  expect(calls).toBe(0);
  release(storyLoopFixtures.SUITE_GREEN);
  await running;
  expect(calls).toBe(1);
  expect(h.updates.some((p) => "reviewOverlapMs" in p)).toBe(false);
});

test("covered suite remains sequential and supplies green suite state", async () => {
  let args: Parameters<typeof h.env.steps.storyReview> | undefined;
  let suites = 0;
  const h = makeStoryLoopHarness(
    { gates: [{ ...storyLoopFixtures.GREEN, suiteCovered: true }] },
    {
      steps: {
        fullSuite: async () => {
          suites++;
          return storyLoopFixtures.SUITE_GREEN;
        },
        storyReview: async (...value) => {
          args = value;
          return { ran: true, verdict: storyLoopFixtures.PASS };
        },
      },
    },
  );
  await runStoryLoop({ ...h.env, parallelReview: true });
  expect(suites).toBe(0);
  expect(args?.[1]?.["full-suite"]).toBe("green");
  expect(args?.[2]).toBeUndefined();
});

test("re-review waits for the next full suite", async () => {
  let release: (value: typeof storyLoopFixtures.SUITE_GREEN) => void = () => {};
  let entered: () => void = () => {};
  const pending = new Promise<typeof storyLoopFixtures.SUITE_GREEN>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let suites = 0;
  let rereviews = 0;
  const h = makeStoryLoopHarness(
    { review: [failingReview()] },
    {
      steps: {
        fullSuite: async () => {
          suites++;
          if (suites === 1) return storyLoopFixtures.SUITE_GREEN;
          entered();
          return pending;
        },
        reReview: async (_round, findings) => {
          rereviews++;
          return {
            ran: true,
            verdict: { verdicts: findings.map((f) => ({ id: f.id, addressed: true, note: "" })), newFindings: [] },
          };
        },
      },
    },
  );
  const running = runStoryLoop({ ...h.env, parallelReview: true });
  await started;
  expect(rereviews).toBe(0);
  release(storyLoopFixtures.SUITE_GREEN);
  await running;
  expect(rereviews).toBe(1);
});

test("red suite and first review findings reach the same fix", async () => {
  const h = makeStoryLoopHarness({ suite: [storyLoopFixtures.SUITE_RED], review: [failingReview()] });
  await runStoryLoop({ ...h.env, parallelReview: true });
  const fix = h.turns.find((turn) => turn.kind === "fix");
  expect(fix?.kind).toBe("fix");
  if (fix?.kind !== "fix") return;
  expect(fix.findings.map((f) => f.kind)).toEqual(["gate", "spec"]);
});

test("report precedes suite and overlap measures the earlier settlement", async () => {
  const events: string[] = [];
  let release: (value: typeof storyLoopFixtures.SUITE_GREEN) => void = () => {};
  let signal: () => void = () => {};
  const pending = new Promise<typeof storyLoopFixtures.SUITE_GREEN>((resolve) => {
    release = resolve;
  });
  const reviewed = new Promise<void>((resolve) => {
    signal = resolve;
  });
  let clock = 0;
  const h = makeStoryLoopHarness(
    {
      implement: async (turn) => {
        events.push(turn.kind);
        return storyLoopFixtures.OK;
      },
    },
    {
      steps: {
        reportExists: async () => false,
        fullSuite: async () => {
          events.push("suite");
          return pending;
        },
        storyReview: async () => {
          clock = 100;
          signal();
          return { ran: true, verdict: storyLoopFixtures.PASS };
        },
      },
    },
  );
  const running = runStoryLoop({ ...h.env, parallelReview: true, now: () => clock });
  await reviewed;
  await Promise.resolve();
  await Promise.resolve();
  clock = 300;
  release(storyLoopFixtures.SUITE_GREEN);
  await running;
  expect(events).toEqual(["implement", "report", "suite"]);
  expect(h.updates).toContainEqual({ reviewOverlapMs: 100 });
});

test.each(["suite", "review"])("a %s rejection waits for the other task", async (failed) => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const error = new Error("failed");
  let settled = false;
  const h = makeStoryLoopHarness(
    {},
    {
      steps: {
        fullSuite: async () => {
          if (failed === "suite") throw error;
          entered();
          await pending;
          return storyLoopFixtures.SUITE_GREEN;
        },
        storyReview: async () => {
          if (failed === "review") throw error;
          entered();
          await pending;
          return { ran: true, verdict: storyLoopFixtures.PASS };
        },
      },
    },
  );
  const running = runStoryLoop({ ...h.env, parallelReview: true }).finally(() => {
    settled = true;
  });
  const checked = running.catch((e: unknown) => e);
  await started;
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  expect(await checked).toBe(error);
});

test("skipped parallel review is recorded unreviewed", async () => {
  const h = makeStoryLoopHarness({ review: [null] });
  expect((await runStoryLoop({ ...h.env, parallelReview: true })).unreviewed).toBe(true);
});
