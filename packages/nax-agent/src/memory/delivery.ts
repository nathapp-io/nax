/**
 * What a delivered write does to the mirror.
 *
 * A drain's job does not end when the provider says yes: the answer has to be written back,
 * and *which* copy of the note it is written onto is the delicate part. Two shapes of queued
 * `save` reach a drain, and they mean different things about the mirror:
 *
 * - a **staged** write, whose note the mirror holds — the save had the mirror's lock, wrote
 *   its note there, and queued the request. The mirror is then the newer fact (it may have
 *   been edited since), so only the provider's `id` and `status` are news;
 * - a **fenced** write, queued while another writer owned the mirror, whose note the mirror
 *   has never seen. The provider now holds content the mirror does not: writing back only the
 *   id and status would leave the mirror on whatever older note it happened to hold, and the
 *   entry carrying the new content is about to be removed — the write would be lost.
 *
 * The two are told apart by generation, not by recency: the mirror holds this write's note
 * exactly when the ids agree. When they do not, the mirror holds *some* other note, and the
 * only thing that makes it authoritative is that it is itself still on its way — that is, its
 * id is still a queued entry of this outbox, staged by a save that has not been delivered yet.
 * A mirror note in that state is a newer local generation and is left alone; anything else is
 * the older copy the fenced write supersedes.
 */
import type { MemoryOutbox, MemoryOutboxEntry } from "./outbox.ts";
import type { MemoryPushResult } from "./provider-types.ts";
import { rewindPullCursor } from "./pull-cursor.ts";
import type { MemoryStore } from "./store.ts";

/** What applying a delivery needs: the mirror to write and the queue that says what is still coming. */
export interface MemoryDeliveryInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
}

/** Whether `id` names a write this outbox has queued and not yet delivered — a staged generation. */
async function awaitingDelivery(outbox: MemoryOutbox, id: string): Promise<boolean> {
  return (await outbox.list()).some((entry) => entry.state === "queued" && entry.clientId === id);
}

/**
 * Write one accepted `save` back into the mirror: the provider's id and status, onto the copy
 * the provider's content came from.
 *
 * A `forget` deletes only on `deleted`: a proposal-mode forget the provider has merely
 * recorded is still pending, and the note it names stays until it is not.
 *
 * Any other answer to a `direct` forget means the note is gone from the mirror and still live
 * on the provider: it was deleted when the request was queued, and the entry carries no copy
 * of it to write back. The pull is the only route left, and it is an incremental one, so the
 * scope's cursor goes back to the beginning — the provider's still-active row is sent again and
 * the mirror takes it in full. A `proposal` entry never deleted anything, so it has nothing to
 * recover and leaves the cursor exactly where it was.
 */
export async function applyPushed(
  input: MemoryDeliveryInput,
  entry: MemoryOutboxEntry,
  answer: MemoryPushResult,
): Promise<void> {
  if (entry.kind === "forget") {
    if (answer.status === "deleted") {
      await input.store.deleteNote(entry.scope, entry.slug);
      return;
    }
    if (entry.writeMode === "direct") await rewindPullCursor(input.store, entry.scope);
    return;
  }
  const delivered = entry.note;
  if (delivered === undefined) return;
  const mirrored = await input.store.readNote(entry.scope, entry.slug);
  if (mirrored !== null && mirrored.id !== delivered.id && (await awaitingDelivery(input.outbox, mirrored.id))) {
    // A newer local generation is still queued: it is the copy that will be delivered next.
    return;
  }
  const base = mirrored !== null && mirrored.id === delivered.id ? mirrored : delivered;
  await input.store.writeNote({ ...base, id: answer.id, status: answer.status });
}
