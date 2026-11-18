/**
 * Decode speed (US-007): how fast a turn's model actually decoded, measured from the turn's
 * own event stream. `decodeRate` folds that stream into tokens per second and
 * `turnStatsText` composes the muted row a finished turn leaves under its reply.
 *
 * A model answers in rounds, and each round reports its own `usage`, so the rate is the
 * tokens of every measured round over the time those rounds spent decoding — summed, never
 * averaged over the rounds. A round's window opens at its first delta, thinking or text,
 * whichever arrives first, and closes at its `usage`; a `stream_reset` reopens it at the next
 * delta, because the tokens already streamed were thrown away. A round with no window at all,
 * or one that closed on no time, contributes to neither half of the fraction.
 *
 * `turnStatsEntry` composes the one row every finished turn leaves in the transcript, and
 * `turnEndClock` says when it ended (US-004). A turn that ended `completed` states what it
 * measured — its rate, its output, its elapsed time — and when it stopped; a turn that was
 * cancelled, timed out, interrupted or errored states how it ended and when, so a long run's
 * last row always answers "how long has this been idle?". The clock comes from the end
 * event's own `at`, so a row drawn later never claims a later time; a resumed session's
 * replayed history never reaches this module and leaves the transcript alone.
 *
 * Everything here is pure: the events in, the number or the row out.
 */
import type { SessionEvent, TurnEndStatus } from "@nathapp/nax-agent";
import { formatTokens, isSubagentEvent } from "./chat-status";
import { formatDuration } from "./duration";
import type { TranscriptEntry } from "./transcript-model";

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

/** What separates the row's parts. */
const SEPARATOR = " · ";
const MILLIS_PER_SECOND = 1000;
const RATE_SCALE = 10;
const RATE_DECIMALS = 1;
const RATE_UNIT = " tok/s";
const OUT_UNIT = " out";

/** The round windows open now, by round: the instant each one's first delta arrived. */
type Windows = Map<number, number>;

/** An event's `at` in epoch milliseconds; undefined when it does not parse (a fixture's "now"). */
function timeOf(at: string): number | undefined {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Opens the round's window at this delta unless it is already open — the first one wins. */
function openWindow(windows: Windows, event: EventOf<"text_delta" | "thinking_delta" | "tool_input_delta">): void {
  const at = timeOf(event.at);
  if (at === undefined || windows.has(event.round)) return;
  windows.set(event.round, at);
}

/** What closing the round's window at `event` measured: its tokens and its duration. */
interface Measured {
  readonly tokens: number;
  readonly ms: number;
}

/**
 * Closes the round's window at its `usage`. A round opened by no delta, or closed on an
 * instant that did not parse, measured nothing; one closed on no positive time measured a
 * window too short to report, and is left out of the rate rather than dividing by it.
 */
function closeWindow(windows: Windows, event: EventOf<"usage">): Measured {
  const start = windows.get(event.round);
  windows.delete(event.round);
  const end = timeOf(event.at);
  if (start === undefined || end === undefined) return { tokens: 0, ms: 0 };
  const ms = end - start;
  return ms > 0 ? { tokens: event.outputTokens, ms } : { tokens: 0, ms: 0 };
}

function roundToOne(value: number): number {
  return Math.round(value * RATE_SCALE) / RATE_SCALE;
}

/**
 * The turn's decoding throughput in tokens per second, or undefined when no round both
 * opened a window and closed it on positive time. Rounded to one decimal.
 */
export function decodeRate(events: readonly SessionEvent[]): number | undefined {
  const windows: Windows = new Map();
  let tokens = 0;
  let measuredMs = 0;
  for (const event of events) {
    if (isSubagentEvent(event)) continue;
    if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "tool_input_delta") {
      openWindow(windows, event);
    } else if (event.type === "stream_reset") {
      windows.delete(event.round);
    } else if (event.type === "usage") {
      const measured = closeWindow(windows, event);
      tokens += measured.tokens;
      measuredMs += measured.ms;
    }
  }
  if (measuredMs <= 0) return undefined;
  return roundToOne((tokens / measuredMs) * MILLIS_PER_SECOND);
}

/** The English month names: a row past today names the month the same way in every locale. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const CLOCK_PAD = 2;
const CLOCK_PAD_CHAR = "0";
const DAY_SPACE = " ";

function twoDigits(value: number): string {
  return value.toString().padStart(CLOCK_PAD, CLOCK_PAD_CHAR);
}

/** Whether two instants fall on the same local calendar day. */
function sameLocalDay(one: Date, other: Date): boolean {
  return (
    one.getFullYear() === other.getFullYear() &&
    one.getMonth() === other.getMonth() &&
    one.getDate() === other.getDate()
  );
}

/**
 * When a turn ended, as the reader's own clock reads it (US-004): `14:32` when that is today,
 * and `Nov 14 23:05` when it is not — a long turn can outlive the day it started on. An
 * `endedAt` that does not parse states nothing, so the row keeps the rest of what it says.
 */
export function turnEndClock(endedAt: string, now: Date): string {
  const endedMs = timeOf(endedAt);
  if (endedMs === undefined) return "";
  const ended = new Date(endedMs);
  const clock = `${twoDigits(ended.getHours())}:${twoDigits(ended.getMinutes())}`;
  if (sameLocalDay(ended, now)) return clock;
  return `${MONTHS[ended.getMonth()]}${DAY_SPACE}${ended.getDate()}${DAY_SPACE}${clock}`;
}

/** What a row states before its end clock. */
export interface TurnStatsInput {
  readonly rate: number | undefined;
  readonly outputTokens: number;
  readonly elapsedMs: number;
  /** When the turn ended, as its own event reported it. */
  readonly endedAt?: string;
  /** The reader's clock, which decides whether `endedAt` is drawn as a bare time. Defaults to now. */
  readonly now?: Date;
}

/** Appends the turn's end clock when it has one; an absent or unparseable end time adds nothing. */
function withEndClock(text: string, input: TurnStatsInput): string {
  if (input.endedAt === undefined) return text;
  const clock = turnEndClock(input.endedAt, input.now ?? new Date());
  return clock === "" ? text : `${text}${SEPARATOR}${clock}`;
}

/**
 * The row a finished turn states: `48.2 tok/s · 1.3k out · 14s`, then ` · 14:32` for when it
 * ended. A turn whose rounds measured no window has no rate to state, and the row keeps the
 * output and the elapsed time alone.
 */
export function turnStatsText(input: TurnStatsInput): string {
  const output = formatTokens(input.outputTokens);
  const spent = `${output}${OUT_UNIT}${SEPARATOR}${formatDuration(input.elapsedMs)}`;
  const measured =
    input.rate === undefined ? spent : `${input.rate.toFixed(RATE_DECIMALS)}${RATE_UNIT}${SEPARATOR}${spent}`;
  return withEndClock(measured, input);
}

/** How long the turn ran, from its `turn_start` to `end`: 0 when either instant does not parse. */
function turnElapsedMs(events: readonly SessionEvent[], end: EventOf<"turn_end">): number {
  const start = events.find((event) => event.type === "turn_start" && !isSubagentEvent(event));
  const from = start === undefined ? undefined : timeOf(start.at);
  const to = timeOf(end.at);
  if (from === undefined || to === undefined) return 0;
  return Math.max(0, to - from);
}

/** The word a turn that did not complete states before its clock. */
const STATUS_WORDS = {
  cancelled: "cancelled",
  timed_out: "timed out",
  interrupted: "interrupted",
  errored: "errored",
} as const satisfies Record<Exclude<TurnEndStatus, "completed">, string>;

/** A turn that completed states what it measured; one that did not states how it ended. */
function completedText(events: readonly SessionEvent[], end: EventOf<"turn_end">, now: Date): string {
  return turnStatsText({
    rate: end.usage.outputTokens > 0 ? decodeRate(events) : undefined,
    outputTokens: end.usage.outputTokens,
    elapsedMs: turnElapsedMs(events, end),
    endedAt: end.at,
    now,
  });
}

/**
 * The stats row a turn earns (US-004). Every turn end leaves one: a completed turn states what
 * it measured and when it ended, and a cancelled, timed out, interrupted or errored turn states
 * how it ended and when — a long run's last row is how the reader knows how long it has been
 * idle. The clock comes from the end event's own `at`, never from when the row is drawn.
 */
export function turnStatsEntry(
  events: readonly SessionEvent[],
  end: EventOf<"turn_end">,
  now: Date = new Date(),
): TranscriptEntry {
  if (end.status === "completed") {
    return { kind: "turn-stats", text: completedText(events, end, now) };
  }
  const word = STATUS_WORDS[end.status];
  const clock = turnEndClock(end.at, now);
  return { kind: "turn-stats", text: clock === "" ? word : `${word}${SEPARATOR}${clock}` };
}
