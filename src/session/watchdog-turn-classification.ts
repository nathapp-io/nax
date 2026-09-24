/**
 * Should sendPrompt classify the in-flight turn's failure as the idle
 * watchdog's own cancel?
 *
 * Its own module because `manager.ts` is a grandfathered oversized file that may
 * not grow, and because the decision is pure over its inputs — which is what makes
 * it testable without a SessionManager, an adapter, or a watchdog registry.
 *
 * nax#2218: two adapter shapes carry the watchdog's cancel. ACP throws
 * `SessionTurnError` with `cancelled: true`; the native transport surfaces the
 * same `turnController.abort()` as a plain `AbortError` ("The operation was
 * aborted.") rethrown unmodified. Both must map to fail-stale when the
 * watchdog's wrapped cancel is what fired, or a watchdog-cancelled warm turn
 * poisons the session and the same-agent retry never reaches a model.
 */

import { SessionTurnError } from "../agents/types";

export interface WatchdogTurnClassificationInput {
  /** `_watchdogCancelledCallsBySession` non-empty for this handle — the watchdog's wrapped cancel ran. */
  readonly watchdogFired: boolean;
  /** The error the adapter threw for the cancelled turn. */
  readonly err: unknown;
  /** `opts?.signal?.aborted` — a caller-signalled abort (run-level abort / queue ABORT). */
  readonly signalAborted: boolean;
}

export function isWatchdogCancelledTurn(input: WatchdogTurnClassificationInput): boolean {
  const { watchdogFired, err, signalAborted } = input;
  if (!watchdogFired) return false;
  if (err instanceof SessionTurnError && err.cancelled) return true;
  // A caller-signalled abort is never the watchdog's decision: it must keep the
  // generic-branch behavior (session poisoned, raw error rethrown, no retry) so
  // an aborting run does not retry into its own teardown.
  if (signalAborted) return false;
  // The native transport's abort shape — same predicate the generic abort
  // branch in sendPrompt matches on.
  return err instanceof Error && err.name === "AbortError";
}
