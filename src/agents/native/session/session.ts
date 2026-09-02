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

/** Session name -> transcript directory, so sendTurn and close can find it. */
export const nativeTranscriptDirs = new Map<string, string>();

export async function openNativeSession(name: string, opts: OpenSessionOpts): Promise<SessionHandle> {
  // Never defaulted. An adapter that picks its own path writes a transcript
  // somewhere nobody looks, which is #1794's empty-packageDir bug one layer up.
  if (!opts.transcriptDir) {
    throw new NaxError(`native session "${name}" opened without a transcriptDir`, "NATIVE_TRANSCRIPT_DIR_MISSING", {
      stage: "native-session",
    });
  }
  nativeTranscriptDirs.set(name, opts.transcriptDir);
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
}
