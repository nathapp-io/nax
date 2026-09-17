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

export function createSpinBreaker(settings: ResolvedSpinBreakerSettings): SpinBreaker {
  const points = nudgePoints(settings);
  // Insertion-ordered and capped: a Map's iteration order gives the eviction
  // order for free, so the window needs no second structure. The value is a
  // cumulative count, so a re-issued key reads as a continuation of its
  // prior count — but only for keys still in the window: an evicted key is
  // gone, and the next sighting will start fresh at 1. That is the same
  // windowing tradeoff `newKeyEvents` already documents, just on the count
  // axis.
  const recent = new Map<string, number>();
  let repeatsSinceProgress = 0;
  let totalCalls = 0;
  let newKeyEvents = 0;
  let maxRepeatRun = 0;
  let maxSameKeyRepeats = 0;
  let nudges = 0;

  function remember(key: string): void {
    recent.set(key, 1);
    newKeyEvents += 1;
    if (recent.size > settings.recentKeyWindow) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
  }

  function buildNudge(toolName: string): SpinVerdict {
    nudges += 1;
    getSafeLogger()?.warn("spin-breaker", "Repeated calls with no progress — nudging", {
      tool: toolName,
      repeats: repeatsSinceProgress,
      nudgeNumber: nudges,
      newKeyEvents,
    });
    return {
      action: "nudge",
      nudgeNumber: nudges,
      repeats: repeatsSinceProgress,
      text: nudgeText(nudges, repeatsSinceProgress),
    };
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

      const cumulativeCount = (recent.get(key) ?? 0) + 1;
      recent.set(key, cumulativeCount);
      if (cumulativeCount > maxSameKeyRepeats) maxSameKeyRepeats = cumulativeCount;

      // Cumulative per-key stop. A freshly-laundered loop is the shape we
      // want to catch (nax#2047). Only check when the knob is non-zero —
      // 0 disables.
      if (settings.stopAfterSameKeyRepeats > 0 && cumulativeCount >= settings.stopAfterSameKeyRepeats) {
        // nax#2120: the stop CONSUMES the evidence it fired on. Without this
        // the count stays above the threshold forever, and because the
        // breaker is session-scoped (nax#2047) every later turn died on its
        // first re-occurrence of this key — a ratchet, not a spin. Set to 0
        // rather than deleting the entry: the key must stay in `recent` so
        // its next occurrence still reads as a repeat, not as progress.
        recent.set(key, 0);
        getSafeLogger()?.error("spin-breaker", "Ending the turn — same call repeated with no progress", {
          tool: toolName,
          repeats: cumulativeCount,
          reason: "same-key-cumulative",
          newKeyEvents,
          totalCalls,
          nudges,
        });
        return { action: "stop", repeats: cumulativeCount, reason: "same-key-cumulative" };
      }

      repeatsSinceProgress += 1;
      if (repeatsSinceProgress > maxRepeatRun) maxRepeatRun = repeatsSinceProgress;

      if (repeatsSinceProgress >= settings.stopAfterRepeats) {
        getSafeLogger()?.error("spin-breaker", "Ending the turn — repeated calls with no progress", {
          tool: toolName,
          repeats: repeatsSinceProgress,
          reason: "repeat-run",
          newKeyEvents,
          totalCalls,
          nudges,
        });
        return { action: "stop", repeats: repeatsSinceProgress, reason: "repeat-run" };
      }

      const isNudgePoint = points.includes(repeatsSinceProgress);
      if (isNudgePoint && nudges < settings.maxNudges) return buildNudge(toolName);

      return { action: "allow" };
    },

    summary() {
      return { totalCalls, newKeyEvents, maxRepeatRun, maxSameKeyRepeats, nudges };
    },
  };
}
