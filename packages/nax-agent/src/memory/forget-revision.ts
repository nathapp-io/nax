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
 */
import type { MemoryNote, MemoryPendingForget } from "./types.ts";

/** Whether the note the entry named has since been replaced by a different note. */
export function isStaleForget(entry: MemoryPendingForget, note: MemoryNote | null): boolean {
  if (typeof entry.noteId !== "string") return false;
  if (note === null) return false;
  return note.id !== entry.noteId;
}
