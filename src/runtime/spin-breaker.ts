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
}

export const DEFAULT_SPIN_BREAKER_SETTINGS: ResolvedSpinBreakerSettings = Object.freeze({
  enabled: true,
  nudgeAfterRepeats: 25,
  maxNudges: 3,
  stopAfterRepeats: 50,
  recentKeyWindow: 64,
});

export type SpinVerdict =
  | { readonly action: "allow" }
  | { readonly action: "nudge"; readonly nudgeNumber: number; readonly repeats: number; readonly text: string }
  | { readonly action: "stop"; readonly repeats: number };

export interface SpinSummary {
  readonly totalCalls: number;
  readonly distinctKeys: number;
  readonly maxRepeatRun: number;
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

function callKey(toolName: string, input: unknown): string {
  const body = stableStringify(input);
  const clipped = body.length > MAX_KEY_BYTES ? String(Bun.hash(body)) : body;
  return `${toolName}:${clipped}`;
}

/**
 * Nudge points are derived from the three knobs rather than configured
 * separately: with 25/50/3 they fall at 25, 33 and 41, leaving the stop at 50.
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
  // order for free, so the window needs no second structure.
  const recent = new Map<string, true>();
  let repeatsSinceProgress = 0;
  let totalCalls = 0;
  let distinctKeys = 0;
  let maxRepeatRun = 0;
  let nudges = 0;

  function remember(key: string): void {
    recent.set(key, true);
    distinctKeys += 1;
    if (recent.size > settings.recentKeyWindow) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
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

      repeatsSinceProgress += 1;
      if (repeatsSinceProgress > maxRepeatRun) maxRepeatRun = repeatsSinceProgress;

      if (repeatsSinceProgress >= settings.stopAfterRepeats) {
        getSafeLogger()?.error("spin-breaker", "Ending the turn — repeated calls with no progress", {
          tool: toolName,
          repeats: repeatsSinceProgress,
          distinctKeys,
          totalCalls,
          nudges,
        });
        return { action: "stop", repeats: repeatsSinceProgress };
      }

      const pointIndex = points.indexOf(repeatsSinceProgress);
      if (pointIndex !== -1 && nudges < settings.maxNudges) {
        nudges += 1;
        getSafeLogger()?.warn("spin-breaker", "Repeated calls with no progress — nudging", {
          tool: toolName,
          repeats: repeatsSinceProgress,
          nudgeNumber: nudges,
          distinctKeys,
        });
        return {
          action: "nudge",
          nudgeNumber: nudges,
          repeats: repeatsSinceProgress,
          text: nudgeText(nudges, repeatsSinceProgress),
        };
      }

      return { action: "allow" };
    },

    summary() {
      return { totalCalls, distinctKeys, maxRepeatRun, nudges };
    },
  };
}
