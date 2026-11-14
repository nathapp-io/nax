/**
 * The forget half of the memory operations: what retiring one note costs, and what a provider's
 * answer to it changes.
 *
 * It lives apart from `operations.ts` for two reasons. The save and the approval there each fill
 * a file, and this one has its own subject: a forget is the one write whose local effect (a
 * deleted note) cannot be recovered from the queue, because the request names a slug rather than
 * carrying the note. Everything below follows from that.
 *
 * The declared order is the whole safety story. The intent goes on the queue *before* the note
 * it names is touched, so the provider always hears about a retire the mirror already carried
 * out — a failed delete leaves the entry to be replayed, a transient push leaves it queued, and
 * the next sync finishes the job. Only two answers end it: `deleted` (the retire stands) and a
 * permanent refusal (the entry comes back off, the note is put back under `direct`, and the
 * provider's error reaches the caller, because retrying a refusal would only repeat it).
 *
 * `pending` is the third answer and it is not a retire: the provider recorded the request and has
 * not carried it out. Under `direct` the mirror had already deleted the note, so the note it read
 * before the delete (`previous`) is written back before the index is refreshed — the note first,
 * then the view of the mirror, so the next session reads a mirror that still holds it. Under
 * `proposal` nothing was ever deleted and the note stays exactly as it was.
 *
 * The one thing this module cannot do is put back a note it never held: a queued entry (see
 * `forgetLocked`'s `waiting` arm and the fenced path in `operations.ts`) has no copy of the note,
 * so the recovery there is the pull's — `delivery.ts` rewinds the scope's cursor instead.
 */
import { randomUUID } from "node:crypto";
import { mirrorSyncInFlight, orderedByMirrorLocks, withMirrorLock } from "./mirror-lock.ts";
import { isMemoryPushRejected } from "./note.ts";
import {
  type MemoryForgetInput,
  type MemoryForgetResult,
  noteNotFound,
  refreshIndex,
  writeRefused,
} from "./operations-support.ts";
import type { MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import { discardRefused, restoreForgotten } from "./refusal.ts";
import { GLOBAL_MEMORY_TIMERS, providerAnswers, raceTimeout } from "./support.ts";
import { MEMORY_OP_TIMEOUT_MS, type MemoryNote, type MemoryNoteStatus, memoryNoteKey } from "./types.ts";
import { forgetReasonRefusal } from "./validate.ts";

/** The status a forget rests in with no provider answer: retired, or still awaiting approval. */
const FORGET_STATUS_BY_MODE = {
  direct: "deleted",
  proposal: "pending",
} as const satisfies Record<MemoryForgetInput["writeMode"], MemoryNoteStatus>;

/** The request one forget is pushed as: its own UUID keys the write, and the reason rides along. */
function forgetRequest(input: MemoryForgetInput): MemoryWriteRequest {
  const { scope, slug, writeMode, reason } = input;
  return { kind: "forget", clientId: randomUUID(), scope, slug, writeMode, reason };
}

/** Queue a forget this operation could not deliver, and rebuild the index so its marker shows. */
async function queuedForget(input: MemoryForgetInput): Promise<MemoryForgetResult> {
  await refreshIndex(input);
  return { slug: input.slug, status: FORGET_STATUS_BY_MODE[input.writeMode], delivered: false };
}

/** Whether the answer carries the retire out: only `deleted` does. */
function retired(answer: MemoryPushResult): boolean {
  return answer.status === "deleted";
}

/**
 * The ordered half of a forget: join a sync that owns the mirror, or take the lock and decide
 * under it. Nothing is read from the mirror before the lock is held, so what a forget retires
 * and what the queue is asked about are both the mirror's current answer rather than a stale one.
 */
async function commitForget(input: MemoryForgetInput): Promise<MemoryForgetResult> {
  const request = forgetRequest(input);
  if (mirrorSyncInFlight(input.store)) return await queueFencedForget(input, request);
  return await withMirrorLock(input, () => forgetLocked(input, request));
}

/**
 * The answer while a sync of this process owns the mirror: the request is queued, and the
 * mirror is only read.
 *
 * The note is still required — a forget of a slug the mirror does not hold is refused rather
 * than queued — but nothing is deleted and no index is rendered: an index built from a mirror
 * the sync is halfway through changing would publish its half-written state, and the sync's own
 * refresh is the one that counts.
 */
async function queueFencedForget(input: MemoryForgetInput, request: MemoryWriteRequest): Promise<MemoryForgetResult> {
  if ((await input.store.readNote(input.scope, input.slug)) === null) throw noteNotFound(input);
  await input.outbox.enqueue(request);
  return { slug: input.slug, status: FORGET_STATUS_BY_MODE[input.writeMode], delivered: false };
}

/**
 * Retire the note and deliver the request, while the mirror's lock is held.
 *
 * The intent is declared on the queue *before* the note it names is touched. Under `direct`
 * this method deletes that note, and a delete no durable request records is a retire the
 * provider never hears about — the next pull restores the note and the agent's decision is
 * silently undone. Writing the entry first costs one file write and makes every later failure
 * recoverable: a failed delete leaves the entry to be replayed, a transient push failure
 * leaves it queued, and only a permanent refusal takes it back off (with the note put back,
 * under `direct`, because a refusal will never change).
 *
 * A key the queue already holds is not pushed at all: the new forget joins the queue behind the
 * earlier write, whose own delivery (or the pull that follows a held one) decides what the mirror
 * holds. The note read before the delete is what this call's `pending` answer puts back.
 */
async function forgetLocked(input: MemoryForgetInput, request: MemoryWriteRequest): Promise<MemoryForgetResult> {
  const previous = await input.store.readNote(input.scope, input.slug);
  if (previous === null) throw noteNotFound(input);
  // Read before the entry goes on: the one this call is about to add cannot be "earlier work".
  const waiting = (await input.outbox.heldKeys()).has(memoryNoteKey(input.scope, input.slug));
  await input.outbox.enqueue(request);
  if (input.writeMode === "direct") await input.store.deleteNote(input.scope, input.slug);
  if (waiting) return await queuedForget(input);
  return await handOverForget(input, previous, request);
}

/**
 * Ask the provider to forget the note this operation already queued.
 *
 * Anything short of an acceptance leaves the entry where it is: the entry is what makes the
 * retire durable, not this attempt. Acceptance and a permanent refusal both take it back off
 * — retrying a refusal would repeat it — and the refusal puts the note back under `direct`.
 *
 * An accepted answer is read, not assumed: only `deleted` carried the retire out. For anything
 * else, a `direct` forget's note was already deleted from this mirror and has to be written back
 * from the copy read before the delete, and it is written back *before* the index is refreshed so
 * the index the next session reads still lists it. A `proposal` forget deleted nothing, so its
 * note stands as it was.
 */
async function handOverForget(
  input: MemoryForgetInput,
  previous: MemoryNote,
  request: MemoryWriteRequest,
): Promise<MemoryForgetResult> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  if (!(await providerAnswers(input.provider, timers))) return await queuedForget(input);
  let answer: MemoryPushResult;
  try {
    answer = await raceTimeout(input.provider.push(request), MEMORY_OP_TIMEOUT_MS, timers);
  } catch (error) {
    if (!isMemoryPushRejected(error)) return await queuedForget(input);
    // The refusal is the caller's answer; the entry and the note are put back regardless of
    // whether removing it works, so a refused forget never leaves the note deleted.
    await discardRefused(input, request.clientId);
    if (input.writeMode === "direct") await restoreForgotten(input, previous);
    throw error;
  }
  await input.outbox.remove(request.clientId);
  if (!retired(answer) && input.writeMode === "direct") await restoreForgotten(input, previous);
  await refreshIndex(input);
  return { slug: input.slug, status: answer.status, delivered: true };
}

/**
 * Forget one note: retire it in the mirror and tell the provider, or queue the request.
 *
 * The reason is checked first, before the lock and before anything is written: a justification
 * that is empty, carries a line break or runs past `MEMORY_FORGET_REASON_MAX_CHARS` is refused
 * as `MEMORY_WRITE_REFUSED`, so no such text reaches the request the provider is pushed or the
 * entry a queued forget leaves in the mirror's outbox.
 *
 * A mirror another writer owns is not this forget's to change, so it is coordinated exactly as
 * a save is: this process's chain (`orderedByMirrorLocks`) orders the forgets and saves of one
 * mirror, and the store's lock file orders them across processes. Without the lock a forget could
 * delete a note while another process's save restored or overwrote it, and the queue's order
 * would describe writes that never happened in that order. A permanent refusal is the one answer
 * undone, under `direct`, and it is rethrown; an absent slug is never queued.
 */
export async function forgetMemoryNote(input: MemoryForgetInput): Promise<MemoryForgetResult> {
  const refusal = forgetReasonRefusal(input.reason);
  if (refusal !== null) throw writeRefused(refusal);
  return await orderedByMirrorLocks(input.store, () => commitForget(input));
}
