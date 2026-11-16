/**
 * US-004: the reasons this package gives for its own turn ends, and the
 * abandoned-tool text they produce.
 *
 * nax-agent keeps the same pair (`session/turn-end-abort.ts`,
 * `abandonedToolMessage`), but neither is exported from its public entry, so
 * this package carries its own copies. `TurnEndAbort` keeps the AbortError
 * contract (a NAME, as nax-agent's does): a bare `abort()` already produces a
 * runtime `DOMException` with that name, so a distinguishable reason cannot be
 * a different name — it is a nax-owned class whose name keeps the contract and
 * whose message says WHY the turn ended.
 */

import { NaxError } from "@nathapp/nax-agent";

/** A turn end this package caused: name kept, message names the reason. */
export class TurnEndAbort extends Error {
  override readonly name = "AbortError";
}

/**
 * The text the agent receives for an abandoned embedder tool call.
 *
 * The reason is only observable once the signal has aborted, so this is
 * evaluated at abandonment time, never before the race. `AbortSignal.any` keeps
 * the reason of the source that aborted first, so a caller's own cancel or
 * timeout reason wins over this package's turn-end reason when it fires first.
 *
 * - a `NaxError` reason names its code and message (a session cancel, the turn
 *   deadline, a stalled consumer);
 * - this package's `TurnEndAbort` names its message alone (no error code);
 * - anything else — a bare `abort()`, a runtime `DOMException`, an unrelated
 *   error — keeps the text that says only that the turn ended.
 */
export function abandonedText(name: string, signal: AbortSignal): string {
  const base = `Tool "${name}" was abandoned: the turn ended`;
  const reason: unknown = signal.reason;
  if (reason instanceof NaxError) return `${base} (${reason.code}: ${reason.message}).`;
  if (reason instanceof TurnEndAbort) return `${base} (${reason.message}).`;
  return `${base}.`;
}
