/**
 * The transcript port (S3 spec 5.5). The native loop loads the whole history
 * through it at turn start and saves a fresh snapshot at turn end, so a store
 * is a document store, not a log. nax uses the file store
 * (`createFileTranscriptStore`); an embedder may inject its own.
 */

import type { ConversationMessage } from "@nathapp/nax-ai";

/** Facade-owned turn bookkeeping. The loop never writes it; `markTurn` does. */
export interface TurnMarker {
  readonly turnId: string;
  readonly state: "running" | "ended";
}

/** An ACP backend's record of the agent-side session (S4 spec 5.5). */
export interface TranscriptAcpRecord {
  readonly agentSessionId: string;
  readonly agent: string;
  readonly agentVersion?: string;
  readonly cwd: string;
  /**
   * The agent's cumulative cost reading (USD) at the end of the session's last
   * priced turn. A resumed ACP session measures its next turn's cost from it,
   * because the agent's running total survives a resume (S4-6 D6-a).
   */
  readonly costUsd?: number;
}

export interface TranscriptDoc {
  /** Absent means 1. nax-agent does not write it in S3-1. */
  readonly schemaVersion?: 1;
  /** Absent means "native". */
  readonly backend?: string;
  readonly acp?: TranscriptAcpRecord;
  readonly owner?: string;
  readonly model?: string;
  readonly savedAt: string;
  readonly messages: readonly ConversationMessage[];
  /**
   * Owned by `markTurn`. The loop never writes it, and its saves replace the
   * whole document, so a loop save drops it; the caller re-marks after the turn
   * (S3 spec 5.5 write order: markTurn(running), turn, markTurn(ended)).
   */
  readonly turn?: TurnMarker;
  /** Native instruction discovery audit, independent of compacted message history. */
  readonly instructionSources?: readonly import("./repository-instructions.ts").InstructionSource[];
  readonly instructionDirectories?: readonly string[];
}

export interface TranscriptStore {
  /** `null` when the session has no document yet. */
  load(sessionId: string): Promise<TranscriptDoc | null>;
  /** Replace the document. The loop calls it at turn end and after a caught turn error. */
  save(sessionId: string, doc: TranscriptDoc): Promise<void>;
  /** Move the live document out of `load`'s reach, keeping it for a human. Missing is not an error. */
  retainFailed(sessionId: string): Promise<void>;
  /** Missing is not an error. */
  delete(sessionId: string): Promise<void>;
  /** Read-merge `turn` into the document, creating an empty one when none exists. */
  markTurn(sessionId: string, marker: TurnMarker): Promise<void>;
}
