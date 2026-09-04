/**
 * Native session lifecycle.
 *
 * There is no subprocess and no backend that remembers, so opening a session
 * establishes nothing — it records where the conversation will be kept. ADR-027
 * section 10 predicted exactly this shape: "openSession and closeSession become
 * either no-ops or transcript-file handles".
 */

import type { OpenSessionOpts, SessionHandle } from "@/agents/session-types";
import { NaxError } from "@/errors";
import { NATIVE_AGENT } from "../models";
import { nativeSessionId } from "../session-affinity";
import type { ResolvedCompaction } from "./compaction";
import { deleteTranscript, pruneRetainedTranscripts } from "./transcript-store";

/**
 * Session name -> transcript directory, so sendTurn and close can find it.
 *
 * Cleared only by `closeNativeSession`: a caller that opens a session and
 * never closes it (e.g. an early return, or a thrown error between open and
 * close) leaks an entry here for the lifetime of the process. Harmless in
 * practice (it is a small in-memory map keyed by session name, not a handle
 * to a real resource), but worth knowing when debugging a growing map.
 */
export const nativeTranscriptDirs = new Map<string, string>();

/**
 * Session name -> timeoutSeconds, so sendTurn can bound each `complete()`
 * call with a deadline (whole-branch review finding 4). Same lifecycle as
 * `nativeTranscriptDirs` — populated on open, cleared on close only.
 */
export const nativeSessionTimeouts = new Map<string, number>();

/**
 * Session name -> the runtime hooks handed to openSession. SessionManager
 * passes both (manager.ts, openSession) and the native adapter previously
 * ignored them, which is why the idle watchdog never covered native. Same
 * lifecycle as `nativeTranscriptDirs`: set on open, cleared on close only.
 */
export const nativeSessionStreamHooks = new Map<
  string,
  {
    onStreamActivity?: (event: import("@/runtime").AgentStreamEvent) => void;
    onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  }
>();

/**
 * Session names whose most recent turn failed.
 *
 * `AgentAdapter.closeSession(handle)` carries no failure signal, so the close
 * cannot tell a finished session from a broken one and passed `failed: false`
 * for both -- deleting the transcript of exactly the session whose history the
 * retry needs and a human would read (nax#1838). Rather than widen the adapter
 * interface for one transport, the turn records what it knows here and the
 * close reads it. Same lifecycle as the maps above: written per turn, cleared
 * on close.
 *
 * A later successful turn clears the mark. "Failed" describes the session's
 * current state, not whether it ever stumbled -- a session that recovered and
 * finished is still cleaned up.
 */
export const nativeSessionFailed = new Set<string>();

/** Session name -> resolved compaction settings. Same lifecycle as the maps above. */
export const nativeSessionCompaction = new Map<string, ResolvedCompaction>();

/**
 * Session name -> the last round trip's reported input tokens and the index it
 * covers, so the next estimate can anchor on a real number.
 *
 * In-memory rather than persisted because runNativeTurn reloads the transcript
 * from disk on EVERY turn: without this the second turn of every session would
 * be estimated from scratch. A process restart still loses it, which is the case
 * the reactive backstop covers.
 */
export const nativeSessionLastUsage = new Map<string, { inputTokens: number; anchorIndex: number }>();

/** Records how the session's latest turn ended, for `closeNativeSession`. */
export function markNativeTurnOutcome(sessionName: string, failed: boolean): void {
  if (failed) nativeSessionFailed.add(sessionName);
  else nativeSessionFailed.delete(sessionName);
}

export async function openNativeSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
  // Never defaulted. An adapter that picks its own path writes a transcript
  // somewhere nobody looks, which is #1794's empty-packageDir bug one layer up.
  if (!opts.transcriptDir) {
    throw new NaxError(`native session "${name}" opened without a transcriptDir`, "NATIVE_TRANSCRIPT_DIR_MISSING", {
      stage: "native-session",
    });
  }
  nativeTranscriptDirs.set(name, opts.transcriptDir);
  nativeSessionTimeouts.set(name, opts.timeoutSeconds);
  if (opts.compaction !== undefined) nativeSessionCompaction.set(name, opts.compaction);
  nativeSessionStreamHooks.set(name, {
    ...(opts.onStreamActivity !== undefined ? { onStreamActivity: opts.onStreamActivity } : {}),
    ...(opts.onActiveCall !== undefined ? { onActiveCall: opts.onActiveCall } : {}),
  });
  return {
    id: name,
    agentName: NATIVE_AGENT,
    // Both fields carry the same value on purpose. On ACP they differ because a
    // physical session can be re-established under a stable logical record;
    // native has no reconnect, so its logical and physical identity genuinely
    // coincide. `nativeSessionId` is a pure hash of the name and deliberately
    // not memoised, so this is exactly the id `sendTurn` later puts on the wire.
    protocolIds: { recordId: nativeSessionId(name), sessionId: nativeSessionId(name) },
    ...(opts.modelDef !== undefined ? { modelDef: opts.modelDef } : {}),
    ...(opts.modelTier !== undefined ? { modelTier: opts.modelTier } : {}),
  };
}

/**
 * Kept on failure, deleted on success. Every Phase B op is lifetime "fresh", so
 * the transcript survives exactly when it is worth reading. The kept-on-failure
 * set is otherwise unbounded, so a failed close also prunes the feature's
 * `sessions/` directory down to `MAX_RETAINED_TRANSCRIPTS` (ADR-028 section 3).
 */
export async function closeNativeSession(handle: SessionHandle, failed?: boolean): Promise<void> {
  const dir = nativeTranscriptDirs.get(handle.id);
  // An explicit argument wins; otherwise the last turn's own verdict decides.
  // The adapter passes nothing, because its interface has no failure signal.
  const treatAsFailed = failed ?? nativeSessionFailed.has(handle.id);
  if (dir !== undefined) {
    if (treatAsFailed) {
      await pruneRetainedTranscripts(dir);
    } else {
      await deleteTranscript(dir, handle.id);
    }
  }
  nativeTranscriptDirs.delete(handle.id);
  nativeSessionTimeouts.delete(handle.id);
  nativeSessionStreamHooks.delete(handle.id);
  nativeSessionFailed.delete(handle.id);
  nativeSessionCompaction.delete(handle.id);
  nativeSessionLastUsage.delete(handle.id);
}
