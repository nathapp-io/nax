/**
 * The provider seam: the one interface the sync loop, the outbox drain and the
 * save / forget operations talk to. A provider is any object that can pull a
 * page of notes, push one write and say whether it is reachable; `search` is
 * optional because the mirror answers keyword search locally
 * (`searchMemoryNotes`), so only a provider with a remote search index needs it.
 *
 * A provider refuses a write it will never accept by throwing `NaxError` code
 * `MEMORY_PUSH_REJECTED` with the reason as its message; `isMemoryPushRejected`
 * recognises it. Every other throw, and a timeout, is transient and retryable —
 * unless the provider declares the write non-replayable (`MemoryReplayContract`),
 * in which case a dispatch that left no answer is an unknown outcome and nothing
 * resends it.
 */
import type { MemoryDecision, MemoryHit, MemoryNote, MemoryNoteStatus, MemoryScope } from "./types.ts";

/** One write to hand a provider: a note to store, or a slug to forget (a tombstone). */
export interface MemoryWriteRequest {
  readonly kind: MemoryWriteKind;
  readonly clientId: string; // MEMORY_CLIENT_ID_RE; idempotency key
  readonly scope: MemoryScope;
  readonly slug: string;
  readonly writeMode: "direct" | "proposal";
  readonly note?: MemoryNote; // present for "save"
  readonly reason?: string; // present for "forget"
}

/** The two writes a provider performs: a note to store, or a slug to retire. */
export type MemoryWriteKind = "save" | "forget";

/**
 * What a provider declares about repeating a write, when a push it was handed left no answer.
 *
 * The default — no `replay` at all — is the contract every provider had before this existed: a
 * push that failed is transient, and a later sync sending it again is exactly right. A provider
 * whose writes are not idempotent on its side says so here, and then a push that was dispatched
 * and never answered is an *unknown* outcome: it may have committed, so nothing resends it. The
 * entry stays in the outbox for an operator to requeue or discard (`state: "uncertain"`).
 *
 * Opt-in on purpose. Inferring safety from a tool's name, or from a search hit matching the
 * text, would let a provider claim a delivery it cannot prove.
 */
export interface MemoryReplayContract {
  /**
   * The writes that may not be dispatched twice. A push of one of these that failed after it
   * left this process is held as unknown rather than retried.
   */
  readonly nonReplayable: readonly MemoryWriteKind[];
  /**
   * What outliving `MEMORY_OP_TIMEOUT_MS` leaves behind.
   *
   * `"late"` (the default) is the honest answer for a client that cannot cancel the call: the
   * abandoned dispatch may still reach the provider and commit, so a timed-out non-replayable
   * write is unknown. `"none"` says the provider abandons the dispatch on that deadline — an
   * aborted request, or one not yet written to the wire — so nothing can arrive afterwards, and
   * the write is a definite unsent one a later sync may safely retry.
   */
  readonly timeoutAftermath?: "late" | "none";
}

/** What the provider made of a write: the note id (or the client id) and its status. */
export interface MemoryPushResult {
  readonly id: string;
  readonly status: MemoryNoteStatus;
}

/** One page of a pull; `done` is only true on the last page. */
export interface MemoryPage {
  readonly notes: readonly MemoryNote[]; // tombstones carry status superseded | rejected | deleted
  readonly decisions?: readonly MemoryDecision[]; // honoured on project pages only
  readonly nextCursor?: string;
  readonly done: boolean;
}

/** The injectable provider seam; `local` is the built-in, always-reachable one. */
export interface MemoryProvider {
  readonly id: string;
  /**
   * Whether this provider's writes may be repeated, when a push it was handed left no answer.
   * Absent, every write is replay-safe and a failed push is retried by the next sync.
   */
  readonly replay?: MemoryReplayContract;
  pull(input: { scope: MemoryScope; cursor: string | null; take: number }): Promise<MemoryPage>;
  push(request: MemoryWriteRequest): Promise<MemoryPushResult>;
  search?(input: { scope: MemoryScope; text: string; limit: number }): Promise<readonly MemoryHit[]>;
  reachable(): Promise<boolean>;
}
