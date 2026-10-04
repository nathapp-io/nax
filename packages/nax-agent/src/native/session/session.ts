/**
 * Native session lifecycle.
 *
 * There is no subprocess and no backend that remembers, so opening a session
 * establishes nothing — it records where the conversation will be kept. ADR-027
 * section 10 predicted exactly this shape: "openSession and closeSession become
 * either no-ops or transcript-file handles".
 */

import { NaxError } from "#src/infra/index";
import { createSpinBreaker, type SpinBreaker } from "#src/infra/spin-breaker/index";
import type { AgentStreamEvent } from "#src/session/agent-stream-events";
import type { OpenSessionOpts, SessionHandle } from "#src/session/session-types";
import { NATIVE_AGENT } from "../models.ts";
import { nativeSessionId } from "../session-affinity.ts";
import type { ResolvedCompaction } from "./compaction.ts";
import { createFileTranscriptStore } from "./transcript-store.ts";
import type { TranscriptStore } from "./transcript-types.ts";
import type { TurnRetryConfig } from "./turn-retry.ts";

/** The runtime hooks handed to openSession. */
export interface NativeSessionStreamHooks {
  onStreamActivity?: (event: AgentStreamEvent) => void;
  onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
}

/** Where one open session's history lives, and whether close may remove it. */
export interface SessionTranscript {
  readonly store: TranscriptStore;
  readonly retainOnClose: boolean;
}

/**
 * The per-owner state behind the native session lifecycle.
 *
 * Every map below is keyed by session name and owned by one state instance, so
 * two owners (the orchestrator and a test, or two concurrent runs) never share
 * an entry for the same deterministic name.
 */
export interface NativeSessionState {
  /**
   * Session name -> transcript directory, so sendTurn and close can find it.
   *
   * Cleared by every close path — `closeNativeSession` (in-process) and the
   * adapter's `closePhysicalSession` (run teardown, which only has the name) —
   * through the shared `clearNativeSessionState`. A caller that opens a session
   * and never closes it (e.g. an early return, or a thrown error between open and
   * close) still leaks an entry for the lifetime of the state. Harmless in
   * practice (it is a small in-memory map keyed by session name, not a handle
   * to a real resource), but worth knowing when debugging a growing map.
   */
  readonly transcriptDirs: Map<string, string>;

  /**
   * Session name -> the session's transcript store and close policy (S3-1).
   * Set by every `openNativeSession`; read through `sessionTranscriptFor`. Same
   * lifecycle as the maps above: set on open, cleared on close.
   */
  readonly transcripts: Map<string, SessionTranscript>;

  /**
   * Session name -> the root whose `.nax/scratchpad/` holds this session's
   * spill files (US-003).
   *
   * Recorded from the session's `workdir` at open — the same root the coding
   * tools are confined to — so a spilled body is reachable through
   * `ScratchpadRead` with the relative path the truncation marker names. Same
   * lifecycle as the maps above: set on open, cleared on close.
   */
  readonly scratchpadRoots: Map<string, string>;

  /**
   * Session name -> timeoutSeconds, so sendTurn can bound each `complete()`
   * call with a deadline (whole-branch review finding 4). Same lifecycle as
   * `transcriptDirs` — populated on open, cleared on close only.
   */
  readonly timeouts: Map<string, number>;

  /**
   * Session name -> the runtime hooks handed to openSession. SessionManager
   * passes both (manager.ts, openSession) and the native adapter previously
   * ignored them, which is why the idle watchdog never covered native. Same
   * lifecycle as `transcriptDirs`: set on open, cleared on close only.
   */
  readonly streamHooks: Map<string, NativeSessionStreamHooks>;

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
  readonly failed: Set<string>;

  /**
   * Session name -> the identity that owns this session's transcript (nax#1877).
   *
   * Read by `runNativeTurn` on both the load and the save, so a transcript left
   * behind by an abandoned invocation of the same deterministic session name is
   * recognised as foreign rather than silently resumed. Same lifecycle as the
   * maps above: set on open, cleared on close.
   */
  readonly transcriptOwners: Map<string, string>;

  /** Session name -> resolved compaction settings. Same lifecycle as the maps above. */
  readonly compaction: Map<string, ResolvedCompaction>;

  /**
   * Session name -> resolved transport-fault retry settings (nax#1870). Same
   * lifecycle as the maps above: set on open, cleared on close.
   */
  readonly transportRetry: Map<string, TurnRetryConfig>;

  /**
   * Session name -> live `SpinBreaker` instance (nax#2013, lifetime extended in
   * nax#2047). Constructed once at open so the cumulative counter survives
   * across `runNativeTurn` calls — a fix round that opens a new turn on the
   * same `handle.id` must inherit the prior turn's evidence rather than start
   * fresh. Same lifecycle as `transportRetry`: set on open, cleared on close.
   */
  readonly spinBreakers: Map<string, SpinBreaker>;

  /**
   * Session name -> the last round trip's reported input tokens and the index it
   * covers, so the next estimate can anchor on a real number.
   *
   * In-memory rather than persisted because runNativeTurn reloads the transcript
   * from disk on EVERY turn: without this the second turn of every session would
   * be estimated from scratch. A process restart still loses it, which is the case
   * the reactive backstop covers.
   *
   * `model` is the transcript model identity the anchor was measured under
   * (P3 spec 8.3(d)); read it through `sessionAnchorFor`, never directly.
   */
  readonly lastUsage: Map<string, SessionAnchor>;
}

export function createNativeSessionState(): NativeSessionState {
  return {
    transcriptDirs: new Map(),
    transcripts: new Map(),
    scratchpadRoots: new Map(),
    timeouts: new Map(),
    streamHooks: new Map(),
    failed: new Set(),
    transcriptOwners: new Map(),
    compaction: new Map(),
    transportRetry: new Map(),
    spinBreakers: new Map(),
    lastUsage: new Map(),
  };
}

export interface SessionAnchor {
  readonly promptTokens: number;
  readonly anchorIndex: number;
  readonly model?: string;
}

/**
 * The persisted anchor a turn on `model` may use. Prefix stability is a
 * property of (model, prefix) (P3 spec 3.3): an anchor measured under a
 * different model indexes history the transcript store refused (spec 8.3(c)),
 * so it is dropped here rather than mis-sizing the next compaction decision.
 * An entry or a turn with no model makes no claim — the store's own rule.
 */
export function sessionAnchorFor(
  state: NativeSessionState,
  sessionName: string,
  model: string | undefined,
): SessionAnchor | undefined {
  const entry = state.lastUsage.get(sessionName);
  if (entry?.model === undefined || model === undefined || entry.model === model) return entry;
  state.lastUsage.delete(sessionName);
  return undefined;
}

/** Records how the session's latest turn ended, for `closeNativeSession`. */
export function markNativeTurnOutcome(state: NativeSessionState, sessionName: string, failed: boolean): void {
  if (failed) state.failed.add(sessionName);
  else state.failed.delete(sessionName);
}

/**
 * The session's transcript. A state seeded with only a transcript directory
 * (tests that drive `runNativeTurn` without opening) resolves to the file store
 * over it; `openNativeSession` always records an entry, so production does not
 * take that path.
 */
export function sessionTranscriptFor(state: NativeSessionState, sessionName: string): SessionTranscript | undefined {
  const opened = state.transcripts.get(sessionName);
  if (opened !== undefined) return opened;
  const dir = state.transcriptDirs.get(sessionName);
  return dir === undefined ? undefined : { store: createFileTranscriptStore(dir), retainOnClose: false };
}

function openTranscriptStore(name: string, opts: OpenSessionOpts): TranscriptStore {
  if (opts.transcriptDir && opts.transcriptStore !== undefined) {
    throw new NaxError(
      `native session "${name}" opened with both a transcriptDir and a transcriptStore`,
      "NATIVE_TRANSCRIPT_SOURCE_CONFLICT",
      { stage: "native-session" },
    );
  }
  if (opts.transcriptStore !== undefined) return opts.transcriptStore;
  // Never defaulted. An adapter that picks its own path writes a transcript
  // somewhere nobody looks, which is #1794's empty-packageDir bug one layer up.
  if (!opts.transcriptDir) {
    throw new NaxError(
      `native session "${name}" opened without a transcriptDir or transcriptStore`,
      "NATIVE_TRANSCRIPT_DIR_MISSING",
      { stage: "native-session" },
    );
  }
  return createFileTranscriptStore(opts.transcriptDir);
}

export async function openNativeSession(
  state: NativeSessionState,
  name: string,
  opts: OpenSessionOpts,
): Promise<SessionHandle> {
  const store = openTranscriptStore(name, opts);
  if (opts.transcriptDir) state.transcriptDirs.set(name, opts.transcriptDir);
  else state.transcriptDirs.delete(name);
  state.transcripts.set(name, { store, retainOnClose: opts.retainOnClose === true });
  state.timeouts.set(name, opts.timeoutSeconds);
  state.scratchpadRoots.set(name, opts.workdir);
  if (opts.transcriptOwner !== undefined) state.transcriptOwners.set(name, opts.transcriptOwner);
  else state.transcriptOwners.delete(name);
  // `resume` is SessionManager's "this name already has a descriptor in this
  // process" signal, and it had no consumer on this transport (nax#1877) — a
  // native session resumed whatever transcript happened to be on disk. Honouring
  // it here is the flag's documented contract; the owner check in historyFromTranscript
  // is what covers the cases `resume` cannot see (a same-process re-entry into a
  // stage, and a process that died without closing anything).
  if (opts.resume !== true) await store.delete(name);
  if (opts.compaction !== undefined) state.compaction.set(name, opts.compaction);
  if (opts.transportRetry !== undefined) state.transportRetry.set(name, opts.transportRetry);
  if (opts.spinBreaker !== undefined) state.spinBreakers.set(name, createSpinBreaker(opts.spinBreaker));
  state.streamHooks.set(name, {
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
 * Clear every state entry for one session name.
 *
 * Extracted so both close paths share one source of truth. `closeNativeSession`
 * has a `SessionHandle`; the adapter's `closePhysicalSession` gets only the
 * handle string that run teardown carries (`descriptor.handle`). The two are
 * the same string — every map is keyed by the session name, and `SessionHandle.id`
 * is that name — but the signatures are not interchangeable, so this helper is
 * string-keyed rather than reconstructed into a synthetic handle.
 */
export function clearNativeSessionState(state: NativeSessionState, sessionName: string): void {
  state.transcriptDirs.delete(sessionName);
  state.transcripts.delete(sessionName);
  state.timeouts.delete(sessionName);
  state.scratchpadRoots.delete(sessionName);
  state.transcriptOwners.delete(sessionName);
  state.streamHooks.delete(sessionName);
  state.failed.delete(sessionName);
  state.compaction.delete(sessionName);
  state.transportRetry.delete(sessionName);
  state.spinBreakers.delete(sessionName);
  state.lastUsage.delete(sessionName);
}

/**
 * Kept on failure, deleted on success. Every Phase B op is lifetime "fresh", so
 * the transcript survives exactly when it is worth reading. Keeping is the
 * store's `retainFailed`; the file store's also prunes the feature's
 * `sessions/` directory down to `MAX_RETAINED_TRANSCRIPTS` (ADR-028 section 3),
 * since the kept-on-failure set is otherwise unbounded. A session opened with
 * `retainOnClose` skips both: its live document stays resumable.
 */
export async function closeNativeSession(
  state: NativeSessionState,
  handle: SessionHandle,
  failed?: boolean,
): Promise<void> {
  const transcript = sessionTranscriptFor(state, handle.id);
  // An explicit argument wins; otherwise the last turn's own verdict decides.
  // The adapter passes nothing, because its interface has no failure signal.
  const treatAsFailed = failed ?? state.failed.has(handle.id);
  try {
    if (transcript !== undefined && !transcript.retainOnClose) {
      // Retain for a human, out of reach of the next session of this name.
      if (treatAsFailed) await transcript.store.retainFailed(handle.id);
      else await transcript.store.delete(handle.id);
    }
  } finally {
    // The deletes must run even when the transcript I/O throws: a failed
    // cleanup step is no reason to strand the session's other state.
    clearNativeSessionState(state, handle.id);
  }
}
