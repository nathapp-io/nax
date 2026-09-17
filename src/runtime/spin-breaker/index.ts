/**
 * Repetition breaker for an agent turn.
 *
 * A verifier session ran 36 minutes re-running the same PASSING scoped test
 * 622 times, emitted no verdict, and was ended by an operator (nax#2013). Every
 * call was fast and exited 0, so there was no timeout, no error rate and no
 * failing gate to trip; what distinguished it was repetition without progress
 * — 622 calls across 2 distinct argv shapes and no file writes.
 *
 * Deliberately NOT a round-trip cap. That was removed twice on purpose
 * (#1823/#1827/#1830, then #1819/#1820) and a session making 600 VARIED calls
 * is working, not spinning. This counts only calls whose normalised shape was
 * already seen.
 *
 * Transport-neutral and config-free by construction: it takes resolved
 * settings, so `src/agents/native/` can consult it without reading NaxConfig
 * (check:adapter-no-config-import).
 */

import { getSafeLogger } from "@/logger";
import { byCodePoint } from "@/utils/sort";
import { stripControlChars } from "@/utils/strip-control-chars";

export interface ResolvedSpinBreakerSettings {
  readonly enabled: boolean;
  /** Repeats since the last new call before the first nudge. */
  readonly nudgeAfterRepeats: number;
  /** How many nudges to spend before the hard stop. */
  readonly maxNudges: number;
  /** Repeats since the last new call at which the turn ends. */
  readonly stopAfterRepeats: number;
  /** How many recent distinct keys count as "already seen". */
  readonly recentKeyWindow: number;
  /**
   * Cumulative repeats of the same call (counted across all interleavings)
   * at which the turn ends. Closes the laundering hole that lets a single
   * call shape repeat endlessly when a different key fires between
   * occurrences — nax#2047 measured 69 identical calls and `maxRepeatRun=22`
   * against a threshold of 25, so a 25-only check was one interleaving away
   * from never tripping. `0` disables the cumulative check.
   */
  readonly stopAfterSameKeyRepeats: number;
}

export const DEFAULT_SPIN_BREAKER_SETTINGS: ResolvedSpinBreakerSettings = Object.freeze({
  enabled: true,
  nudgeAfterRepeats: 25,
  maxNudges: 3,
  stopAfterRepeats: 50,
  recentKeyWindow: 64,
  stopAfterSameKeyRepeats: 12,
});

export type SpinVerdict =
  | { readonly action: "allow" }
  | { readonly action: "nudge"; readonly nudgeNumber: number; readonly repeats: number; readonly text: string }
  | { readonly action: "stop"; readonly repeats: number; readonly reason: "repeat-run" | "same-key-cumulative" };

export interface SpinSummary {
  readonly totalCalls: number;
  /**
   * Cache-misses against the bounded `recentKeyWindow`, i.e. how many times
   * this session did something new. Equal to true key cardinality only while
   * the session's distinct-key count stays within `recentKeyWindow` — once a
   * key is evicted from the window, seeing it again counts as another new-key
   * event, so this is NOT a reliable "unique calls this session made" count
   * for a long session. Deliberately not backed by an unbounded Set: the
   * window exists to bound memory, and "how many new things happened" is the
   * more useful number for a spin diagnostic anyway.
   */
  readonly newKeyEvents: number;
  readonly maxRepeatRun: number;
  /**
   * Highest cumulative repeat count observed for a single key (nax#2047).
   * Same windowing tradeoff as `newKeyEvents`: an evicted key loses its
   * count, so this is the peak within the current window rather than a
   * session-lifetime peak. The `maxRepeatRun` field above stays the
   * instrument for #2013's 622-call varied verifier; this is the new
   * instrument for the laundering hole — they answer different questions.
   */
  readonly maxSameKeyRepeats: number;
  readonly nudges: number;
}

export interface SpinBreaker {
  observe(toolName: string, input: unknown): SpinVerdict;
  /**
   * Feed back what a call returned. `observe` runs pre-execution, so the
   * result of occurrence N is only known when occurrence N+1 is judged —
   * that one-call lag is intentional and harmless at these thresholds.
   * Calls that are denied or throw never reach here; those keys fall back
   * to the raw backstop inside `observe`.
   */
  noteResult(toolName: string, input: unknown, resultText: string): void;
  summary(): SpinSummary;
}

/** Beyond this, the key is hashed — one large input must not grow the key set without bound. */
const MAX_KEY_BYTES = 512;

/** Deterministic regardless of property order, so a reordered input is the same call. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort((a, b) => byCodePoint(a[0], b[0]));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

/**
 * Strips the tokens that differ between two byte-identical runs: elapsed
 * times and clock timestamps (ANSI escapes are removed by
 * `stripControlChars` first). Deliberately surgical rather than blanking
 * every digit — "2 failed" -> "1 failed" is real progress and must survive
 * normalisation, while "in 1.20s" -> "in 1.23s" must not.
 */
const DURATION_OR_TIMESTAMP =
  /\b\d+(?:\.\d+)?\s?(?:ms|s|m|min)\b|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b|\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g;

function resultDigest(text: string): string {
  const normalised = stripControlChars(text).replace(DURATION_OR_TIMESTAMP, "").replace(/\s+/g, " ").trim();
  return String(Bun.hash(normalised));
}

/**
 * Tool names are fixed identifiers (e.g. "Read", "RunCommand") that never
 * contain a space, so concatenating on one never lets `toolName="a:b"` +
 * `body="c"` collide with `toolName="a"` + `body="b:c"` the way a colon would.
 */
const KEY_SEPARATOR = " ";

function callKey(toolName: string, input: unknown): string {
  const body = stableStringify(input);
  const clipped = body.length > MAX_KEY_BYTES ? String(Bun.hash(body)) : body;
  return `${toolName}${KEY_SEPARATOR}${clipped}`;
}

/**
 * Nudge points are derived from the three knobs rather than configured
 * separately: with 25/50/3 they fall at 25, 33 and 42, leaving the stop at 50.
 */
function nudgePoints(settings: ResolvedSpinBreakerSettings): readonly number[] {
  const span = settings.stopAfterRepeats - settings.nudgeAfterRepeats;
  return Array.from({ length: settings.maxNudges }, (_unused, index) =>
    Math.round(settings.nudgeAfterRepeats + (index * span) / settings.maxNudges),
  );
}

const NUDGE_ESCALATION: readonly string[] = [
  "You have made {repeats} tool calls without issuing a new, distinct call. You are repeating work already done and the results are not changing. Stop re-running and produce your final answer now, in the exact format your instructions require.",
  "You are still repeating the same calls ({repeats} with no new work). If you cannot conclude, say so explicitly in your final answer and stop — an explicit inability to conclude is a valid answer; repeating is not.",
  "Final warning: {repeats} repeated calls with no progress. The next repeated call ends this session with no answer recorded. Produce your final answer now.",
];

function nudgeText(nudgeNumber: number, repeats: number): string {
  const template = NUDGE_ESCALATION[Math.min(nudgeNumber, NUDGE_ESCALATION.length) - 1] ?? NUDGE_ESCALATION[0];
  return (template ?? "").replace("{repeats}", String(repeats));
}

interface KeyRecord {
  /** Raw cumulative occurrences — the backstop, and what `summary` reports. */
  count: number;
  /** Consecutive occurrences whose result digest was unchanged. */
  sameResultRun: number;
  digest?: string;
}

export function createSpinBreaker(settings: ResolvedSpinBreakerSettings): SpinBreaker {
  const points = nudgePoints(settings);
  // Insertion-ordered and capped: a Map's iteration order gives the eviction
  // order for free, so the window needs no second structure. The value carries
  // the cumulative count and the same-result run, so a re-issued key reads as
  // a continuation of its prior state — but only for keys still in the window:
  // an evicted key is gone, and the next sighting will start fresh at 1. That
  // is the same windowing tradeoff `newKeyEvents` already documents, just on
  // the count axis.
  const recent = new Map<string, KeyRecord>();
  let repeatsSinceProgress = 0;
  let totalCalls = 0;
  let newKeyEvents = 0;
  let maxRepeatRun = 0;
  let maxSameKeyRepeats = 0;
  let nudges = 0;

  function remember(key: string): void {
    recent.set(key, { count: 1, sameResultRun: 0 });
    newKeyEvents += 1;
    if (recent.size > settings.recentKeyWindow) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
  }

  function buildNudge(toolName: string, repeats: number): SpinVerdict {
    nudges += 1;
    getSafeLogger()?.warn("spin-breaker", "Repeated calls with no progress — nudging", {
      tool: toolName,
      repeats,
      nudgeNumber: nudges,
      newKeyEvents,
    });
    return { action: "nudge", nudgeNumber: nudges, repeats, text: nudgeText(nudges, repeats) };
  }

  /**
   * nax#2120: the escalation ladder must always render before a kill. The
   * nudge points are derived from `repeatsSinceProgress`, but the cumulative
   * per-key check runs on a different counter, so for a loop over 1-2
   * already-seen keys the first nudge point was unreachable by arithmetic
   * and the turn was killed cold with `nudges: 0`.
   *
   * Deliberately NOT a config refinement: reachability depends on the loop's
   * CYCLE LENGTH, not on the knobs, so no cross-field inequality can express
   * it. Spending a nudge instead costs at most `maxNudges` extra calls before
   * a genuine nax#2047 kill, and makes `nudges: 0` on a stop unreachable for
   * every configuration.
   *
   * `onStop` runs only when the verdict is a real stop — the Task 1 evidence
   * reset must not fire on a downgrade, or the threshold could never be
   * reached twice and the loop would nudge forever.
   */
  function stopOrNudge(
    toolName: string,
    repeats: number,
    reason: "repeat-run" | "same-key-cumulative",
    onStop?: () => void,
  ): SpinVerdict {
    if (nudges < settings.maxNudges) return buildNudge(toolName, repeats);
    onStop?.();
    getSafeLogger()?.error("spin-breaker", "Ending the turn — repeated calls with no progress", {
      tool: toolName,
      repeats,
      reason,
      newKeyEvents,
      totalCalls,
      nudges,
    });
    return { action: "stop", repeats, reason };
  }

  return {
    observe(toolName, input) {
      if (!settings.enabled) return { action: "allow" };
      totalCalls += 1;
      const key = callKey(toolName, input);

      if (!recent.has(key)) {
        remember(key);
        repeatsSinceProgress = 0;
        return { action: "allow" };
      }

      const record = recent.get(key) ?? { count: 0, sameResultRun: 0 };
      record.count += 1;
      recent.set(key, record);
      if (record.count > maxSameKeyRepeats) maxSameKeyRepeats = record.count;

      // nax#2120: the cumulative threshold now runs on the RESULT axis. Same
      // call + same result N times is a spin whatever interleaved; same call
      // with a changing result is an edit -> test loop, which is work. The
      // raw count is kept as a backstop for a call whose result is unique
      // every time, or which never reaches `noteResult` (denied, threw) —
      // `stopAfterRepeats` bounds it without adding a knob.
      if (settings.stopAfterSameKeyRepeats > 0 && record.sameResultRun >= settings.stopAfterSameKeyRepeats) {
        return stopOrNudge(toolName, record.sameResultRun, "same-key-cumulative", () => {
          record.count = 0;
          record.sameResultRun = 0;
        });
      }
      if (settings.stopAfterSameKeyRepeats > 0 && record.count >= settings.stopAfterRepeats) {
        return stopOrNudge(toolName, record.count, "same-key-cumulative", () => {
          record.count = 0;
          record.sameResultRun = 0;
        });
      }

      repeatsSinceProgress += 1;
      if (repeatsSinceProgress > maxRepeatRun) maxRepeatRun = repeatsSinceProgress;

      if (repeatsSinceProgress >= settings.stopAfterRepeats) {
        return stopOrNudge(toolName, repeatsSinceProgress, "repeat-run");
      }

      const isNudgePoint = points.includes(repeatsSinceProgress);
      if (isNudgePoint && nudges < settings.maxNudges) return buildNudge(toolName, repeatsSinceProgress);

      return { action: "allow" };
    },

    noteResult(toolName, input, resultText) {
      if (!settings.enabled) return;
      const record = recent.get(callKey(toolName, input));
      if (record === undefined) return;
      const digest = resultDigest(resultText);
      record.sameResultRun = record.digest === digest ? record.sameResultRun + 1 : 1;
      record.digest = digest;
    },

    summary() {
      return { totalCalls, newKeyEvents, maxRepeatRun, maxSameKeyRepeats, nudges };
    },
  };
}
