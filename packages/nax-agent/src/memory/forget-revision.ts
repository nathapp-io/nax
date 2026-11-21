/**
 * Whether a recorded forget still names the note it was written for.
 *
 * A `proposal` forget is queued in the mirror's `pending-forgets.jsonl` and acted on later, by
 * an approval that may run in another process — and possibly after a different project refiled
 * the same slug. The entry therefore carries the `id` of the note the mirror held when it was
 * written, and this is the one place that answers whether that revision is still the note's.
 *
 * The note's `id` is the revision, not its `updatedAt`: every save stages a fresh
 * `randomUUID()`, while approving the same pending note elsewhere restamps `updatedAt` and
 * keeps the id. So a restamp is the same note (not stale) and a refile is a different one
 * (stale) — which is exactly the pair of cases a timestamp could not tell apart.
 *
 * Both absences answer `false`. An entry with no `noteId` was recorded before the field
 * existed and keeps the behaviour it had then — an approval acts on it. A `null` note is not a
 * revision question at all: there is nothing to act on, and the caller's refusal is
 * `MEMORY_NOTE_NOT_FOUND`.
 *
 * Exported from this module for the approval and the index (US-002). It is deliberately not
 * part of the package's public entry: no caller outside nax-agent records or reads a forget.
 *
 * `settleRecordedForget` is the acting half of that answer, and it lives here for the same
 * reason: an approval and an index refresh both have to ask it, and neither should own it.
 */
import type { MemoryStore } from "./store.ts";
import { type MemoryNote, type MemoryPendingForget, type MemoryScope, memoryNoteKey } from "./types.ts";

/** Whether the note the entry named has since been replaced by a different note. */
export function isStaleForget(entry: MemoryPendingForget, note: MemoryNote | null): boolean {
  if (typeof entry.noteId !== "string") return false;
  if (note === null) return false;
  return note.id !== entry.noteId;
}

/**
 * What the record holds for one key, once a forget aimed at an older revision is dropped:
 * `none` when the record has no entry for it, `held` when the entry still names the note the
 * mirror holds, and `dropped` when it named a note that has since been replaced and was taken
 * out of the record on the way here.
 */
export type RecordedForget = "none" | "held" | "dropped";

/** The key an approval or a refresh asks about, plus the note the mirror holds under it. */
export interface RecordedForgetQuery {
  readonly store: MemoryStore;
  readonly scope: MemoryScope;
  readonly slug: string;
  /** The note this caller read under the key: what an entry is judged against. */
  readonly note: MemoryNote;
}

/**
 * Read the record's entry for one key and settle whether it is still about the held note.
 *
 * This is the one place the revision check decides anything, so an approval and the index
 * cannot disagree about what a stale entry means. A stale entry is *removed*, not merely
 * reported: it can never become current again, and leaving it would keep marking a note the
 * next session reads as live and would make every later approval re-decide the same question.
 *
 * The record is re-read before it is rewritten — the same way `retireRecorded` writes it — so an
 * entry another writer appended after the first read survives this write. That re-read is why the
 * entry is judged from the first read and the file is rewritten from the second: the judgement is
 * about a note the caller holds, while the write is about a file other writers share.
 */
export async function settleRecordedForget(input: RecordedForgetQuery): Promise<RecordedForget> {
  const key = memoryNoteKey(input.scope, input.slug);
  const entry = (await input.store.readPendingForgets()).find(
    (candidate) => memoryNoteKey(candidate.scope, candidate.slug) === key,
  );
  if (entry === undefined) return "none";
  if (!isStaleForget(entry, input.note)) return "held";
  const recorded = await input.store.readPendingForgets();
  await input.store.writePendingForgets(
    recorded.filter((candidate) => memoryNoteKey(candidate.scope, candidate.slug) !== key),
  );
  return "dropped";
}
