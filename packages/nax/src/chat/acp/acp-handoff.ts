/**
 * The bounded handoff: the newest contiguous run of handoff entries that fits
 * a total character budget, and the notice for a handoff that had to be cut.
 *
 * Pure: no I/O, no config, no clock. The bounds are constants, not settings.
 */
import { type HandoffEntry, handoffEntries } from "./acp-handoff-entries";
import type { ChatMessage } from "./acp-history";

/** Total UTF-16 code units of every kept entry's `speaker.length + text.length`. */
export const ACP_HANDOFF_MAX_CHARS = 40_000;

export interface AcpHandoff {
  readonly entries: readonly HandoffEntry[];
  /** How many earlier entries were dropped to fit the bound. */
  readonly omitted: number;
}

/**
 * handoffEntries(messages), bounded to the newest contiguous suffix within
 * ACP_HANDOFF_MAX_CHARS. Entries are admitted newest first and the walk stops
 * at the first one that does not fit, so a short older entry never skips over
 * a long newer one.
 */
export function acpHandoff(messages: readonly ChatMessage[]): AcpHandoff {
  const all = handoffEntries(messages);
  let total = 0;
  let start = all.length;
  while (start > 0) {
    const entry = all[start - 1];
    if (entry === undefined) break;
    const size = entry.speaker.length + entry.text.length;
    if (total + size > ACP_HANDOFF_MAX_CHARS) break;
    total += size;
    start -= 1;
  }
  return { entries: all.slice(start), omitted: start };
}

/** The handle notice for a handoff whose oldest entries were dropped. */
export function ACP_HANDOFF_TRIMMED_NOTICE(label: string, omitted: number): string {
  return `${label} was not given the ${omitted} oldest earlier message(s); the handoff is capped`;
}
