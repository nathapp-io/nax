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
import { decodeRate, turnStatsEntry, turnStatsText } from "@/tui/chat/turn-stats";

/** Every case states its window in milliseconds past this instant. */
const BASE = Date.parse("2026-10-26T00:00:00.000Z");

function at(ms: number): string {
  return new Date(BASE + ms).toISOString();
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

describe("turnStatsText", () => {
  test("AC-7 states the rate, the output and the whole seconds", () => {
    expect(turnStatsText({ rate: 48.2, outputTokens: 1_300, elapsedMs: 14_400 })).toBe("48.2 tok/s · 1.3k out · 14s");
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
});

describe("turnStatsEntry", () => {
  const TURN = [turnStart(0), textDelta(0), usage(5_000, 241)];

  test("builds the row a completed turn with output earns", () => {
    expect(turnStatsEntry(TURN, turnEnd(14_400, "completed", 1_300))).toEqual({
      kind: "turn-stats",
      text: "48.2 tok/s · 1.3k out · 14s",
    });
  });

  test("is undefined for a turn that did not complete, whatever it streamed", () => {
    for (const status of ["cancelled", "errored", "timed_out", "interrupted"] as const) {
      const end = turnEnd(14_400, status, 1_300, { code: "CANCELLED", message: "stopped" });
      expect(turnStatsEntry(TURN, end)).toBeUndefined();
    }
  });

  test("is undefined for a completed turn with no output tokens", () => {
    expect(turnStatsEntry(TURN, turnEnd(14_400, "completed", 0))).toBeUndefined();
  });

  test("counts the elapsed time as none when the turn's own start does not parse", () => {
    const unparseable: SessionEvent = { ...turnStart(0), at: "now" };
    expect(turnStatsEntry([unparseable, textDelta(0), usage(5_000, 241)], turnEnd(14_400, "completed", 1_300))).toEqual(
      { kind: "turn-stats", text: "48.2 tok/s · 1.3k out · 0s" },
    );
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
