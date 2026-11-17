/**
 * US-007: decode speed, measured from one turn's own event stream.
 *
 * A turn streams in rounds; each round opens with deltas and closes with the `usage` the
 * provider reported for it. The rate is therefore the tokens of every measured round over
 * the time those rounds actually spent decoding — summed, not averaged, so one long slow
 * round is not outweighed by one short fast one — and a round whose window never closed, or
 * closed on no time at all, contributes to neither half of the fraction.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, TurnEndStatus } from "@nathapp/nax-agent";
import { isSubagentEvent } from "@/tui/chat/chat-status";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";
import { decodeRate, turnEndClock, turnStatsEntry, turnStatsText } from "@/tui/chat/turn-stats";

/**
 * Every case states its window in milliseconds past 14:32 local time today. The clock a row
 * carries (US-004) is local, so the instant comes from local date parts — that is what keeps
 * a case's expected `14:32` true on every machine, whatever its zone.
 */
const LOCAL_NOW = new Date();
const BASE = new Date(LOCAL_NOW.getFullYear(), LOCAL_NOW.getMonth(), LOCAL_NOW.getDate(), 14, 32, 0, 0).getTime();

/** A local instant today, named by its clock so a case reads as the wall time it means. */
function localTime(hour: number, minute: number): Date {
  return new Date(LOCAL_NOW.getFullYear(), LOCAL_NOW.getMonth(), LOCAL_NOW.getDate(), hour, minute, 0, 0);
}

function at(ms: number): string {
  return new Date(BASE + ms).toISOString();
}

/** The text of the row a turn earned, narrowed — every turn end earns a `turn-stats` row (US-004). */
function rowText(entry: TranscriptEntry): string {
  if (entry.kind !== "turn-stats") throw new Error(`expected a turn-stats row, got ${entry.kind}`);
  return entry.text;
}

interface EventOptions {
  readonly round?: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

function base(ms: number, options: EventOptions = {}) {
  return {
    sessionId: "s1",
    turnId: "t1",
    at: at(ms),
    metadata: options.metadata ?? {},
  };
}

function turnStart(ms: number): SessionEvent {
  return { ...base(ms), type: "turn_start" };
}

function textDelta(ms: number, options: EventOptions = {}): SessionEvent {
  return { ...base(ms, options), type: "text_delta", round: options.round ?? 1, text: "chunk" };
}

function thinkingDelta(ms: number, options: EventOptions = {}): SessionEvent {
  return { ...base(ms, options), type: "thinking_delta", round: options.round ?? 1, text: "hmm" };
}

function streamReset(ms: number, options: EventOptions = {}): SessionEvent {
  return { ...base(ms, options), type: "stream_reset", round: options.round ?? 1, attempt: 2 };
}

function usage(ms: number, outputTokens: number, options: EventOptions = {}): SessionEvent {
  return {
    ...base(ms, options),
    type: "usage",
    round: options.round ?? 1,
    inputTokens: 10,
    outputTokens,
    costUsd: 0.01,
  };
}

function turnEnd(
  ms: number,
  status: TurnEndStatus,
  outputTokens: number,
  error?: { code: string; message: string },
): Extract<SessionEvent, { type: "turn_end" }> {
  return {
    ...base(ms),
    type: "turn_end",
    status,
    output: "chunk",
    usage: { inputTokens: 10, outputTokens },
    costUsd: 0.02,
    ...(error === undefined ? {} : { error }),
  };
}

/** The task the host tags a nested subagent call with. */
const NESTED = { subagentTask: "scan" };

describe("decodeRate", () => {
  test("AC-1 reports the tokens of one round over its own two seconds", () => {
    expect(decodeRate([turnStart(0), textDelta(0), usage(2_000, 100)])).toBe(50);
  });

  test("AC-2 weights two rounds by their windows rather than averaging their rates", () => {
    const events = [
      turnStart(0),
      textDelta(0, { round: 1 }),
      usage(2_000, 100, { round: 1 }),
      textDelta(2_000, { round: 2 }),
      usage(6_000, 300, { round: 2 }),
    ];
    // 400 tokens over 6s is 66.7 tok/s; the rounds' own rates (50 and 75) would average to 62.5.
    expect(decodeRate(events)).toBe(66.7);
  });

  test("AC-3 ignores a nested call's events, as the filtered stream does", () => {
    const mixture = [
      turnStart(0),
      textDelta(0, { round: 1 }),
      thinkingDelta(500, { round: 2, metadata: NESTED }),
      usage(1_500, 1_000, { round: 2, metadata: NESTED }),
      usage(2_000, 100, { round: 1 }),
    ];
    const chatOnly = mixture.filter((event) => !isSubagentEvent(event));
    expect(decodeRate(mixture)).toBe(50);
    expect(decodeRate(mixture)).toBe(decodeRate(chatOnly));
  });

  test("AC-4 opens the window at thinking when thinking comes before text", () => {
    expect(decodeRate([turnStart(0), thinkingDelta(0), textDelta(1_000), usage(2_000, 100)])).toBe(50);
  });

  test("AC-5 restarts the round's window at the delta after a stream reset", () => {
    const events = [
      turnStart(0),
      textDelta(0),
      textDelta(1_000),
      streamReset(1_500),
      textDelta(2_000),
      usage(4_000, 100),
    ];
    // From the reset's next delta: 100 tokens over 2s. Unreset, the window would be 4s.
    expect(decodeRate(events)).toBe(50);
  });

  test("AC-6 returns undefined when no round has both a delta and a usage", () => {
    expect(decodeRate([])).toBeUndefined();
    expect(decodeRate([turnStart(0), textDelta(0)])).toBeUndefined();
    expect(decodeRate([turnStart(0), usage(2_000, 100)])).toBeUndefined();
  });

  test("leaves a round that measured no time out of both halves of the rate", () => {
    const events = [
      textDelta(0, { round: 1 }),
      usage(0, 100, { round: 1 }),
      textDelta(0, { round: 2 }),
      usage(2_000, 100, { round: 2 }),
    ];
    expect(decodeRate(events)).toBe(50);
  });

  test("measures nothing when an event carries no time to measure", () => {
    const unparseable: SessionEvent = { ...textDelta(0), at: "now" };
    expect(decodeRate([unparseable, usage(2_000, 100)])).toBeUndefined();
  });

  test("returns one decimal, not the raw quotient", () => {
    expect(decodeRate([textDelta(0), usage(3_000, 100)])).toBe(33.3);
  });
});

describe("turnEndClock", () => {
  test("US-004 AC-1 states an instant earlier the same local day as its local time", () => {
    expect(turnEndClock(localTime(14, 32).toISOString(), localTime(18, 0))).toBe("14:32");
  });

  test("US-004 AC-2 pads both parts to two digits", () => {
    expect(turnEndClock(localTime(9, 5).toISOString(), localTime(18, 0))).toBe("09:05");
  });

  test("US-004 AC-3 names the month and the day when the instant falls on an earlier local day", () => {
    const endedAt = new Date(2026, 10, 14, 23, 5, 0, 0).toISOString();
    expect(turnEndClock(endedAt, new Date(2026, 10, 15, 0, 10, 0, 0))).toBe("Nov 14 23:05");
  });

  test("US-004 AC-4 returns the empty string for an endedAt that does not parse", () => {
    expect(turnEndClock("now", localTime(18, 0))).toBe("");
  });
});

describe("turnStatsText", () => {
  test("US-004 AC-5 states the rate, the output and the whole seconds without an end time", () => {
    expect(turnStatsText({ rate: 48.2, outputTokens: 1_300, elapsedMs: 14_400 })).toBe("48.2 tok/s · 1.3k out · 14s");
  });

  test("US-004 AC-6 appends the end clock when the turn states when it ended", () => {
    const endedAt = localTime(14, 32).toISOString();
    expect(turnStatsText({ rate: 48.2, outputTokens: 1_300, elapsedMs: 14_400, endedAt, now: localTime(18, 0) })).toBe(
      "48.2 tok/s · 1.3k out · 14s · 14:32",
    );
  });

  test("AC-8 leaves the rate out when no window measured one", () => {
    expect(turnStatsText({ rate: undefined, outputTokens: 1_300, elapsedMs: 14_400 })).toBe("1.3k out · 14s");
  });

  test("reports the elapsed whole seconds rounded down", () => {
    expect(turnStatsText({ rate: undefined, outputTokens: 5, elapsedMs: 999 })).toBe("5 out · 0s");
  });

  test("states a rate over one decimal so the row keeps its column width", () => {
    expect(turnStatsText({ rate: 50, outputTokens: 100, elapsedMs: 2_000 })).toBe("50.0 tok/s · 100 out · 2s");
  });

  test("US-002 AC-13 states a 5,229-second turn as hours, minutes and seconds", () => {
    expect(turnStatsText({ rate: 32.1, outputTokens: 36_000, elapsedMs: 5_229_000 })).toBe(
      "32.1 tok/s · 36.0k out · 1h 27m 09s",
    );
  });

  test("US-002 AC-14 keeps a sub-minute turn's elapsed time as whole seconds", () => {
    expect(turnStatsText({ rate: undefined, outputTokens: 1_300, elapsedMs: 14_000 })).toBe("1.3k out · 14s");
  });
});

describe("turnStatsEntry", () => {
  /** One 5s round of 241 tokens, ended 14.4s in, at 14:32:14 local time. */
  const TURN = [turnStart(0), textDelta(0), usage(5_000, 241)];
  /** Later the same local day, as the screen's clock reads it. */
  const NOW = localTime(18, 0);

  test("US-004 AC-7 states a completed turn's measurement and the time it ended", () => {
    expect(turnStatsEntry(TURN, turnEnd(14_400, "completed", 1_300), NOW)).toEqual({
      kind: "turn-stats",
      text: "48.2 tok/s · 1.3k out · 14s · 14:32",
    });
  });

  test("US-004 AC-8 states a completed turn that reported no output", () => {
    const text = rowText(turnStatsEntry(TURN, turnEnd(14_400, "completed", 0), NOW));
    expect(text.startsWith("0 out · ")).toBe(true);
    expect(text.endsWith(" · 14:32")).toBe(true);
  });

  test.each([
    { ac: "AC-9", status: "cancelled", word: "cancelled" },
    { ac: "AC-10", status: "timed_out", word: "timed out" },
    { ac: "AC-11", status: "interrupted", word: "interrupted" },
    { ac: "AC-12", status: "errored", word: "errored" },
  ] as const)("US-004 $ac states that a $status turn ended at its clock", ({ status, word }) => {
    const end = turnEnd(14_400, status, 1_300, { code: "CANCELLED", message: "stopped" });
    expect(rowText(turnStatsEntry(TURN, end, NOW))).toBe(`${word} · 14:32`);
  });

  test("US-004 AC-13 earns a turn-stats row whatever the turn ended as", () => {
    for (const status of ["completed", "cancelled", "timed_out", "interrupted", "errored"] as const) {
      expect(turnStatsEntry(TURN, turnEnd(14_400, status, 1_300), NOW).kind).toBe("turn-stats");
    }
  });

  test("US-004 AC-14 states the status word alone when the end time does not parse", () => {
    const end = { ...turnEnd(14_400, "cancelled", 1_300), at: "now" };
    expect(rowText(turnStatsEntry(TURN, end, NOW))).toBe("cancelled");
  });

  test("counts the elapsed time as none when the turn's own start does not parse", () => {
    const unparseable: SessionEvent = { ...turnStart(0), at: "now" };
    expect(
      turnStatsEntry([unparseable, textDelta(0), usage(5_000, 241)], turnEnd(14_400, "completed", 1_300), NOW),
    ).toEqual({ kind: "turn-stats", text: "48.2 tok/s · 1.3k out · 0s · 14:32" });
  });
});

function toolInputDelta(ms: number, options: EventOptions = {}): SessionEvent {
  return {
    ...base(ms, options),
    type: "tool_input_delta",
    round: options.round ?? 1,
    callId: "c1",
    name: "Write",
    chars: 9,
  };
}

describe("decodeRate with tool_input_delta", () => {
  test("AC-6 a tool_input_delta opens the round's window", () => {
    expect(decodeRate([turnStart(0), toolInputDelta(1_000), usage(3_000, 100)])).toBe(50);
  });

  test("AC-7 the first delta wins over a later text_delta", () => {
    expect(decodeRate([turnStart(0), toolInputDelta(1_500), textDelta(2_000), usage(3_500, 100)])).toBe(50);
  });
});
