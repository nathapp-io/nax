/**
 * The agent-stream's counters for a call that just ended, handed to the dispatch "Agent call complete"
 * line so the end of a call is ONE info line (nax#2491 P7).
 *
 * Keyed by run and session name: the stream event's `callId` is the transport's, the dispatch event's is the
 * operation's, and the two never match (see `ToolCallRecord.callId`). A note is only handed to a dispatch
 * event whose call was RUNNING when the note's call ended (`endedAt >= the dispatch call's start`), so a note
 * left behind by a call whose dispatch event never came is not attached to the next call. Bounded per run,
 * and dropped when the run's subscribers are detached.
 */
export interface CallEndStats {
  readonly status: string;
  readonly messageUpdates: number;
  readonly thinkingUpdates: number;
  readonly toolCallUpdates: number;
  readonly idleMs: number;
}

interface Note {
  readonly stats: CallEndStats;
  readonly endedAt: number;
}

const MAX_PENDING_PER_RUN = 256;
const pending = new Map<string, Map<string, Note>>();

export function noteCallEnded(runId: string, sessionName: string, stats: CallEndStats, endedAt: number): void {
  const run = pending.get(runId) ?? new Map<string, Note>();
  pending.set(runId, run);
  run.delete(sessionName);
  run.set(sessionName, { stats, endedAt });
  if (run.size > MAX_PENDING_PER_RUN) {
    const oldest = run.keys().next().value;
    if (oldest !== undefined) run.delete(oldest);
  }
}

/** The counters of the session's most recent ended call, once, if that call ended at or after `startedAt`. */
export function takeCallEnded(runId: string, sessionName: string, startedAt: number): CallEndStats | undefined {
  const run = pending.get(runId);
  const note = run?.get(sessionName);
  run?.delete(sessionName);
  return note !== undefined && note.endedAt >= startedAt ? note.stats : undefined;
}

/** Forget a run's notes (its subscribers were detached). */
export function clearRunCallEnds(runId: string): void {
  pending.delete(runId);
}
