/**
 * The agent-stream's counters for a call that just ended, handed to the dispatch "Agent call complete"
 * line so the end of a call is ONE info line (nax#2491 P7).
 *
 * Keyed by session name: the stream event's `callId` is the transport's, the dispatch event's is the
 * operation's, and the two never match (see `ToolCallRecord.callId`). A session runs one call at a time,
 * so the latest note for a session is the call that just ended. Bounded; a note nobody takes is dropped.
 */
export interface CallEndStats {
  readonly status: string;
  readonly messageUpdates: number;
  readonly thinkingUpdates: number;
  readonly toolCallUpdates: number;
  readonly idleMs: number;
}

const MAX_PENDING = 256;
const pending = new Map<string, CallEndStats>();

export function noteCallEnded(sessionName: string, stats: CallEndStats): void {
  pending.delete(sessionName);
  pending.set(sessionName, stats);
  if (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
}

/** The counters of the session's most recent ended call, once. */
export function takeCallEnded(sessionName: string): CallEndStats | undefined {
  const stats = pending.get(sessionName);
  pending.delete(sessionName);
  return stats;
}
