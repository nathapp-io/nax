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
  /**
   * Repeats since the last new call at which the turn ends, AND the raw
   * per-key backstop. Overloaded: `stopAfterSameKeyRepeats` gates the
   * consecutive-identical-result threshold, while the same key's raw
   * cumulative count is separately capped here. That backstop is the only
   * thing that bounds a call whose result changes every time (or never
   * reaches `noteResult`), which the result axis cannot see.
   */
  readonly stopAfterRepeats: number;
  /** How many recent distinct keys count as "already seen". */
  readonly recentKeyWindow: number;
  /**
   * Consecutive occurrences of the same call whose RESULT was unchanged at
   * which the turn ends — the consecutive same-result run, NOT the raw
   * per-key count (which `stopAfterRepeats` caps). This is the axis that
   * closes the nax#2047 laundering hole (a different key firing between
   * occurrences no longer resets the run) without killing a healthy
   * edit -> re-run-test loop, whose result changes each iteration. `0`
   * disables this axis.
   */
  readonly stopAfterSameKeyRepeats: number;
  /**
   * nax#2017: seconds with no new call key after which a repeat run ends the turn, so a slow spin
   * stops as fail-spin before the tool-call-only idle watchdog cancels it as fail-stale. 0 disables.
   */
  readonly stopAfterNoProgressSeconds: number;
}

export const DEFAULT_SPIN_BREAKER_SETTINGS: ResolvedSpinBreakerSettings = Object.freeze({
  enabled: true,
  nudgeAfterRepeats: 25,
  maxNudges: 3,
  stopAfterRepeats: 50,
  recentKeyWindow: 64,
  stopAfterSameKeyRepeats: 12,
  stopAfterNoProgressSeconds: 900,
});

/** Why the breaker ended the turn. Kept exhaustive so telemetry is accurate. */
export type SpinStopReason = "repeat-run" | "same-key-cumulative" | "same-key-backstop" | "no-progress-time";

export type SpinVerdict =
  | { readonly action: "allow" }
  | { readonly action: "nudge"; readonly nudgeNumber: number; readonly repeats: number; readonly text: string }
  | { readonly action: "stop"; readonly repeats: number; readonly reason: SpinStopReason };

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
   * A call that throws never reaches here (an error string is not a result),
   * so it falls back to the raw backstop inside `observe`. A DENIED call
   * does reach here (turn-loop feeds `answer.answer`): a stable denial is an
   * unchanged result and is intended to count toward the same-result run.
   */
  noteResult(toolName: string, input: unknown, resultText: string): void;
  summary(): SpinSummary;
}

/** Beyond this, the key is hashed — one large input must not grow the key set without bound. */
const MAX_KEY_BYTES = 512;

/**
 * nax#2017: repeats of one call that must accumulate before the time axis may
 * end the turn. A deliberate module constant, not a setting — a run of two or
 * three calls is not a spin, however long each one took.
 */
const NO_PROGRESS_TIME_MIN_REPEATS = 5;

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
 *
 * The single-letter `m`/`s` units are ambiguous with ordinary tokens
 * (`file-2m.ts`, "expected 5 m"), so they are stripped only when the number
 * is decimal (`1.2s`) or sits in a time context (`in`/`took`/`time`/
 * `elapsed`/`duration`/`=`/`(`/`,`). `ms` and `min` are unambiguous and stay
 * unconditional. The `ms|s|m|min` alternation is ordered so backtracking
 * still reaches `min`.
 */
const DURATION_OR_TIMESTAMP =
  /\b\d+\.\d+\s?(?:ms|s|m|min)\b|(?:\b(?:in|took|time|elapsed|duration)\s?|[=(,]\s?)\d+\s?[ms]\b|\b\d+(?:\.\d+)?\s?(?:ms|min)\b|\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b|\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g;

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

/**
 * Answered to every outstanding call when the breaker first decides to end a
 * turn (nax#2120). The stop used to break with the call unexecuted and
 * unanswered, so the turn was classified `fail-spin` and retried on the
 * timeout lane — a FRESH session at a reduced budget, discarding everything
 * the turn had accumulated. One terminal round trip lets the model close out
 * instead. NUDGE_ESCALATION's final warning is one step ahead of the hard
 * end, not literally true: the first stop only warns (this notice) and only a
 * further stop verdict ends the turn.
 */
export const SPIN_TERMINAL_NOTICE =
  "[nax] This turn is ending: you repeated the same call with no change in its result. " +
  "This call was not executed. Produce your final answer now, in the exact format your " +
  "instructions require. Any further repeated call ends the turn with no answer recorded.";

const SPIN_RAW_BACKSTOP_TERMINAL_NOTICE =
  "[nax] This turn is ending: the same call reached the safety call limit even though its results changed. " +
  "This call was not executed. Produce your final answer now, in the exact format your " +
  "instructions require. Any further repeated call ends the turn with no answer recorded.";

/**
 * nax#2017: the time axis fires on repetition alone — the ladder is spent on
 * the repeat path, and AC1's own sequence never calls `noteResult` — so the
 * generic notice would assert an unchanged result the breaker never observed.
 * The same reasoning as the raw backstop's copy above: a stop message that
 * claims the wrong diagnostic is worse than a blunter one.
 */
const SPIN_NO_PROGRESS_TIME_TERMINAL_NOTICE =
  "[nax] This turn is ending: you have repeated calls for too long with no new, distinct call. " +
  "This call was not executed. Produce your final answer now, in the exact format your " +
  "instructions require. Any further repeated call ends the turn with no answer recorded.";

/**
 * Exhaustive, so a future stop reason cannot silently inherit copy written for
 * a different diagnostic.
 */
const SPIN_TERMINAL_NOTICES: Readonly<Record<SpinStopReason, string>> = {
  "repeat-run": SPIN_TERMINAL_NOTICE,
  "same-key-cumulative": SPIN_TERMINAL_NOTICE,
  "same-key-backstop": SPIN_RAW_BACKSTOP_TERMINAL_NOTICE,
  "no-progress-time": SPIN_NO_PROGRESS_TIME_TERMINAL_NOTICE,
};

export function spinTerminalNotice(reason: SpinStopReason): string {
  return SPIN_TERMINAL_NOTICES[reason];
}

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

export function createSpinBreaker(
  settings: ResolvedSpinBreakerSettings,
  deps?: { readonly now?: () => number },
): SpinBreaker {
  const points = nudgePoints(settings);
  /**
   * nax#2017: injectable clock (milliseconds). The time axis needs a clock a
   * test can drive; production takes the default (`Date.now`).
   */
  const now = deps?.now ?? Date.now;
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
  /** Session-cumulative; what `summary()` reports. Telemetry meaning unchanged. */
  let nudges = 0;
  /**
   * nax#2017: the budget the ladder actually spends, restored by sustained new
   * work rather than by any single new key. Sessions are long-lived (nax#2047),
   * so a session-lifetime budget left a turn that had already spent its three
   * nudges with no warning left at all.
   */
  let episodeNudges = 0;
  /** `newKeyEvents` when the last nudge was built — the replenishment anchor. */
  let newKeyEventsAtLastNudge = 0;
  /** nax#2017: when a new call key was last seen; the time axis' origin. */
  let lastProgressAt = now();

  function remember(key: string): KeyRecord {
    const record: KeyRecord = { count: 1, sameResultRun: 0 };
    recent.set(key, record);
    newKeyEvents += 1;
    if (recent.size > settings.recentKeyWindow) {
      const oldest = recent.keys().next();
      if (!oldest.done) recent.delete(oldest.value);
    }
    return record;
  }

  function buildNudge(toolName: string, repeats: number): SpinVerdict {
    nudges += 1;
    episodeNudges += 1;
    newKeyEventsAtLastNudge = newKeyEvents;
    getSafeLogger()?.warn("spin-breaker", "Repeated calls with no progress — nudging", {
      tool: toolName,
      repeats,
      nudgeNumber: episodeNudges,
      newKeyEvents,
    });
    return { action: "nudge", nudgeNumber: episodeNudges, repeats, text: nudgeText(episodeNudges, repeats) };
  }

  /**
   * Reason-specific stop messages: the raw backstop fires precisely when the
   * results ARE changing, so reusing the no-progress copy there would invert
   * the one diagnostic that matters.
   */
  const stopMessage: Readonly<Record<SpinStopReason, string>> = {
    "repeat-run": "Ending the turn — repeated calls with no progress",
    "same-key-cumulative": "Ending the turn — the same call returned the same result too many times",
    "same-key-backstop":
      "Ending the turn — the same call repeated too many times (raw backstop; results were changing)",
    "no-progress-time": "Ending the turn — repeated calls with no new call for too long",
  };

  /**
   * The raw per-key backstop: a cap on the cumulative count, and that count
   * includes the call being judged — `remember` seeds a new key at 1. It is
   * therefore checked on the key's FIRST occurrence too, in both branches,
   * rather than only when the key is seen again. For every supported cap
   * (`stopAfterRepeats` has a schema minimum of 3) the first occurrence sits
   * below it and nothing changes; a degenerate cap of 1 stops on the first
   * call rather than the second, and that is the only case where the two
   * readings differ.
   */
  function backstopVerdict(record: KeyRecord, toolName: string): SpinVerdict | undefined {
    if (settings.stopAfterSameKeyRepeats <= 0 || record.count < settings.stopAfterRepeats) return undefined;
    return stopOrNudge(toolName, record.count, "same-key-backstop", () => {
      record.count = 0;
      record.sameResultRun = 0;
    });
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
   *
   * A real stop also consumes `repeatsSinceProgress`, symmetric with the
   * per-key reset. The breaker is session-scoped by design (nax#2047), and
   * the first stop is now reprieved by the turn loop (nax#2120 Task 4): if
   * the run counter stayed latched at the threshold, the next turn would stop
   * cold on its first or second repeated call. It must re-accumulate in full.
   */
  function stopOrNudge(toolName: string, repeats: number, reason: SpinStopReason, onStop?: () => void): SpinVerdict {
    if (episodeNudges < settings.maxNudges) return buildNudge(toolName, repeats);
    onStop?.();
    repeatsSinceProgress = 0;
    // nax#2017: a real stop hands the next run a full ladder. The breaker is
    // session-scoped (nax#2047), so a budget spent in one turn would otherwise
    // deny every later turn its warnings — the shape this story exists to fix.
    episodeNudges = 0;
    getSafeLogger()?.error("spin-breaker", stopMessage[reason], {
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

      const existing = recent.get(key);
      if (existing === undefined) {
        const created = remember(key);
        repeatsSinceProgress = 0;
        // nax#2017: a new call key is progress on the time axis...
        lastProgressAt = now();
        // ...and sustained new work replenishes the episode's nudge budget.
        // Deliberately NOT every new key: a laundering loop that interleaves
        // one fresh key between repeats of a single call (nax#2047) would then
        // restore its own budget forever and never stop.
        if (newKeyEvents - newKeyEventsAtLastNudge >= settings.nudgeAfterRepeats) episodeNudges = 0;
        // Judged on its own first occurrence — see `backstopVerdict`.
        const firstBackstop = backstopVerdict(created, toolName);
        return firstBackstop ?? { action: "allow" };
      }
      const record = existing;
      record.count += 1;
      if (record.count > maxSameKeyRepeats) maxSameKeyRepeats = record.count;

      // nax#2120: the cumulative threshold runs on the RESULT axis. Same call
      // + same result N times is a spin whatever interleaved; same call with
      // a changing result is an edit -> test loop, which is work. The raw
      // count is kept as a backstop for a call whose result is unique every
      // time, or which never reaches `noteResult` (a throw; a DENIAL does
      // reach it) — `stopAfterRepeats` bounds it without adding a knob. The
      // backstop fires while results are changing, hence its own reason.
      if (settings.stopAfterSameKeyRepeats > 0 && record.sameResultRun >= settings.stopAfterSameKeyRepeats) {
        return stopOrNudge(toolName, record.sameResultRun, "same-key-cumulative", () => {
          record.count = 0;
          record.sameResultRun = 0;
        });
      }
      const backstop = backstopVerdict(record, toolName);
      if (backstop !== undefined) return backstop;

      repeatsSinceProgress += 1;
      if (repeatsSinceProgress > maxRepeatRun) maxRepeatRun = repeatsSinceProgress;

      // nax#2017: the time axis. A repeated call that takes ~40 s each reaches
      // the tool-call-only idle watchdog before the repeat thresholds, and the
      // watchdog's cancel is classified `fail-stale` — a retry on the timeout
      // lane, discarding the turn. Ending it here instead makes it `fail-spin`.
      // Checked before the repeat-run threshold so a slow spin ends on time
      // rather than on a count it may never reach.
      if (
        settings.stopAfterNoProgressSeconds > 0 &&
        repeatsSinceProgress >= NO_PROGRESS_TIME_MIN_REPEATS &&
        now() - lastProgressAt >= settings.stopAfterNoProgressSeconds * 1000
      ) {
        return stopOrNudge(toolName, repeatsSinceProgress, "no-progress-time");
      }

      if (repeatsSinceProgress >= settings.stopAfterRepeats) {
        return stopOrNudge(toolName, repeatsSinceProgress, "repeat-run");
      }

      const isNudgePoint = points.includes(repeatsSinceProgress);
      if (isNudgePoint && episodeNudges < settings.maxNudges) return buildNudge(toolName, repeatsSinceProgress);

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
