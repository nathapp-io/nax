/**
 * `chat.compaction` resolvers (US-006, chat-job-panel): the absolute native-chat
 * token cap and the idle delay, each falling back to its own default when the
 * operator configured nothing.
 */
import { describe, expect, test } from "bun:test";
import { fakeTimers, makeFakeClock, makeNaxConfig } from "@test/helpers";
import { chatCompactAtTokens, createIdleCompactor, type IdleCompactState, idleCompactAfterMs } from "@/chat";

describe("chatCompactAtTokens", () => {
  test("AC-7: returns 200000 for a config with no chat block", () => {
    expect(chatCompactAtTokens(makeNaxConfig())).toBe(200_000);
  });

  test("AC-8: returns a configured 100000", () => {
    expect(chatCompactAtTokens(makeNaxConfig({ chat: { compaction: { compactAtTokens: 100_000 } } }))).toBe(100_000);
  });

  test("AC-9: returns 0 when the cap is turned off", () => {
    expect(chatCompactAtTokens(makeNaxConfig({ chat: { compaction: { compactAtTokens: 0 } } }))).toBe(0);
  });

  test("falls back to the default when chat exists without a compaction block", () => {
    expect(chatCompactAtTokens(makeNaxConfig({ chat: { workflow: { specFixRounds: 3 } } }))).toBe(200_000);
  });
});

describe("idleCompactAfterMs", () => {
  test("AC-10: returns 3300000 for a config with no chat block", () => {
    expect(idleCompactAfterMs(makeNaxConfig())).toBe(3_300_000);
  });

  test("AC-11: returns 0 when idle compaction is turned off", () => {
    expect(idleCompactAfterMs(makeNaxConfig({ chat: { compaction: { idleCompactAfterMinutes: 0 } } }))).toBe(0);
  });

  test("converts a configured number of minutes to milliseconds", () => {
    expect(idleCompactAfterMs(makeNaxConfig({ chat: { compaction: { idleCompactAfterMinutes: 5 } } }))).toBe(300_000);
  });
});

/* ---------------------------------------------------------------------------------------
 * US-007: the idle compactor's timer state machine, driven by an injected fake clock.
 * ------------------------------------------------------------------------------------- */

/** The 55-minute delay the config's default resolves to: the story's canonical value. */
const DELAY_MS = 3_300_000;
/** One minute of virtual time, for cases that step the clock in minutes. */
const MINUTE_MS = 60_000;

const RUN_1: IdleCompactState = { idle: true, runningJobId: "run-1", contextTokens: 50_000, acp: false };
const RUN_2: IdleCompactState = { ...RUN_1, runningJobId: "run-2" };
/** The same idle chat with no job running: nothing to condense the history for. */
const NO_JOB: IdleCompactState = { idle: true, contextTokens: 50_000, acp: false };

/** A compactor on a virtual clock, and the reasons it reported. */
function harness(delayMs = DELAY_MS) {
  const clock = makeFakeClock();
  const reasons: string[] = [];
  const compactor = createIdleCompactor({
    delayMs,
    onDue: (reason) => {
      reasons.push(reason);
    },
    timers: fakeTimers(clock),
  });
  return { clock, reasons, compactor };
}

describe("createIdleCompactor", () => {
  test("AC-1: fires 55m after a qualifying idle update names a running job", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update(RUN_1);
    await clock.advance(DELAY_MS - 1);
    expect(reasons).toEqual([]);
    await clock.advance(1);
    expect(reasons).toEqual(["55m idle while job run-1 runs"]);
  });

  test("AC-2: a requalifying update does not restart the timer", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update(RUN_1);
    await clock.advance(3_000_000);
    compactor.update(RUN_1);
    expect(reasons).toEqual([]);
    await clock.advance(DELAY_MS - 3_000_000);
    expect(reasons).toEqual(["55m idle while job run-1 runs"]);
  });

  test("AC-3: never fires again for a job it already fired for", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update(RUN_1);
    await clock.advance(DELAY_MS);
    compactor.update({ ...RUN_1, idle: false });
    compactor.update(RUN_1);
    await clock.advance(DELAY_MS * 2);
    expect(reasons).toEqual(["55m idle while job run-1 runs"]);
  });

  test("AC-4: fires for a second job after firing for the first", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update(RUN_1);
    await clock.advance(DELAY_MS);
    compactor.update({ ...RUN_1, idle: false });
    compactor.update(RUN_2);
    await clock.advance(DELAY_MS);
    expect(reasons).toEqual(["55m idle while job run-1 runs", "55m idle while job run-2 runs"]);
  });

  test("AC-5: a new job re-arms the timer from its own qualifying update", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update(RUN_1);
    await clock.advance(MINUTE_MS);
    compactor.update(RUN_2);
    await clock.advance(DELAY_MS - 1);
    expect(reasons).toEqual([]);
    await clock.advance(1);
    expect(reasons).toEqual(["55m idle while job run-2 runs"]);
  });

  test("AC-6: never fires with no job running", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update(NO_JOB);
    await clock.advance(DELAY_MS * 2);
    expect(reasons).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("AC-7: never fires for an ACP model", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update({ ...RUN_1, acp: true });
    await clock.advance(DELAY_MS * 2);
    expect(reasons).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("AC-8: never fires below the token floor", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update({ ...RUN_1, contextTokens: 19_999 });
    await clock.advance(DELAY_MS * 2);
    expect(reasons).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("AC-9: never fires when the context size is unknown", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update({ idle: true, runningJobId: "run-1", acp: false });
    await clock.advance(DELAY_MS * 2);
    expect(reasons).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("AC-10: never fires when the delay is zero", async () => {
    const { clock, reasons, compactor } = harness(0);
    compactor.update(RUN_1);
    await clock.advance(DELAY_MS);
    expect(reasons).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test("AC-11: an update that stops being idle clears the armed timer", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update(RUN_1);
    await clock.advance(DELAY_MS / 2);
    compactor.update({ ...RUN_1, idle: false });
    expect(clock.pending()).toBe(0);
    await clock.advance(DELAY_MS);
    expect(reasons).toEqual([]);
  });

  test("AC-12: dispose prevents a pending due", async () => {
    const { clock, reasons, compactor } = harness();
    compactor.update(RUN_1);
    compactor.dispose();
    expect(clock.pending()).toBe(0);
    await clock.advance(DELAY_MS * 2);
    expect(reasons).toEqual([]);
  });
});
