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
import { deleteTranscript } from "./transcript-store";

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
  return {
    id: name,
    agentName: NATIVE_AGENT,
    ...(opts.modelDef !== undefined ? { modelDef: opts.modelDef } : {}),
    ...(opts.modelTier !== undefined ? { modelTier: opts.modelTier } : {}),
  };
}

/**
 * Kept on failure, deleted on success. Every Phase B op is lifetime "fresh", so
 * the transcript survives exactly when it is worth reading — and nothing in the
 * repo prunes session directories, so keeping them all would grow without bound
 * (ADR-028 section 3).
 */
export async function closeNativeSession(handle: SessionHandle, failed: boolean): Promise<void> {
  const dir = nativeTranscriptDirs.get(handle.id);
  if (dir !== undefined && !failed) await deleteTranscript(dir, handle.id);
  nativeTranscriptDirs.delete(handle.id);
  nativeSessionTimeouts.delete(handle.id);
}
