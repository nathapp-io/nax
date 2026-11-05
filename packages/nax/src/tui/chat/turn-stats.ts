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
 * `turnStatsEntry` is the one place that decides whether a finished turn earns a row: only a
 * turn that ended `completed` with output to report measures anything, so a cancelled, timed
 * out or errored turn — and a resumed session's replayed history, which never reaches this
 * module — leaves the transcript alone.
 *
 * Everything here is pure: the events in, the number or the row out.
 */
import type { SessionEvent } from "@nathapp/nax-agent";
import { formatTokens, isSubagentEvent } from "./chat-status";
import type { TranscriptEntry } from "./transcript-model";

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

/** What separates the row's parts. */
const SEPARATOR = " · ";
const MILLIS_PER_SECOND = 1000;
const RATE_SCALE = 10;
const RATE_DECIMALS = 1;
const RATE_UNIT = " tok/s";
const OUT_UNIT = " out";
const SECONDS_SUFFIX = "s";

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

/** The whole seconds an elapsed span floors to; a span that does not measure counts as none. */
function wholeSeconds(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.max(0, Math.floor(elapsedMs / MILLIS_PER_SECOND));
}

/**
 * The row a finished turn states: `48.2 tok/s · 1.3k out · 14s`. A turn whose rounds measured
 * no window has no rate to state, and the row keeps the output and the elapsed time alone.
 */
export function turnStatsText(input: { rate: number | undefined; outputTokens: number; elapsedMs: number }): string {
  const output = formatTokens(input.outputTokens);
  const spent = `${output}${OUT_UNIT}${SEPARATOR}${wholeSeconds(input.elapsedMs)}${SECONDS_SUFFIX}`;
  if (input.rate === undefined) return spent;
  return `${input.rate.toFixed(RATE_DECIMALS)}${RATE_UNIT}${SEPARATOR}${spent}`;
}

/** How long the turn ran, from its `turn_start` to `end`: 0 when either instant does not parse. */
function turnElapsedMs(events: readonly SessionEvent[], end: EventOf<"turn_end">): number {
  const start = events.find((event) => event.type === "turn_start" && !isSubagentEvent(event));
  const from = start === undefined ? undefined : timeOf(start.at);
  const to = timeOf(end.at);
  if (from === undefined || to === undefined) return 0;
  return Math.max(0, to - from);
}

/**
 * The stats row a turn earns, or undefined when it earns none. A turn that was cancelled,
 * timed out or errored produced no reply to measure, and one that completed with no output
 * tokens has nothing to report a speed for.
 */
export function turnStatsEntry(events: readonly SessionEvent[], end: EventOf<"turn_end">): TranscriptEntry | undefined {
  if (end.status !== "completed" || end.usage.outputTokens <= 0) return undefined;
  return {
    kind: "turn-stats",
    text: turnStatsText({
      rate: decodeRate(events),
      outputTokens: end.usage.outputTokens,
      elapsedMs: turnElapsedMs(events, end),
    }),
  };
}
