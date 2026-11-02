/**
 * The provider seam: the one interface the sync loop, the outbox drain and the
 * save / forget operations talk to. A provider is any object that can pull a
 * page of notes, push one write and say whether it is reachable; `search` is
 * optional because the mirror answers keyword search locally
 * (`searchMemoryNotes`), so only a provider with a remote search index needs it.
 *
 * A provider refuses a write it will never accept by throwing `NaxError` code
 * `MEMORY_PUSH_REJECTED` with the reason as its message; `isMemoryPushRejected`
 * recognises it. Every other throw, and a timeout, is transient and retryable.
 */
import type { MemoryDecision, MemoryHit, MemoryNote, MemoryNoteStatus, MemoryScope } from "./types.ts";

/** One write to hand a provider: a note to store, or a slug to forget (a tombstone). */
export interface MemoryWriteRequest {
  readonly kind: "save" | "forget";
  readonly clientId: string; // MEMORY_CLIENT_ID_RE; idempotency key
  readonly scope: MemoryScope;
  readonly slug: string;
  readonly writeMode: "direct" | "proposal";
  readonly note?: MemoryNote; // present for "save"
  readonly reason?: string; // present for "forget"
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
  pull(input: { scope: MemoryScope; cursor: string | null; take: number }): Promise<MemoryPage>;
  push(request: MemoryWriteRequest): Promise<MemoryPushResult>;
  search?(input: { scope: MemoryScope; text: string; limit: number }): Promise<readonly MemoryHit[]>;
  reachable(): Promise<boolean>;
}
