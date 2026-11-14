/**
 * The memory operations: what an agent's intent becomes once the store agrees to
 * keep it.
 *
 * `saveMemoryNote` is the write path, and the only place a `MemoryNoteWrite`
 * becomes a `MemoryNote`. Validation comes first and everything else after it:
 * `validateMemoryNoteWrite` owns what may be stored (`validate.ts` — the field
 * limits and the secret scan), so a refusal is thrown as `MEMORY_WRITE_REFUSED`
 * with that reason as its message and nothing on disk is touched. This file adds
 * no rule of its own; it only decides what to do with the answer.
 *
 * A write that passes is staged in the mirror before any provider is asked, and the
 * staging is what outlives a provider that cannot take it: a provider that does not
 * answer, and a push that fails or times out, leave the note exactly where it is and
 * put the request — under the id the note was staged with — on the outbox, so a later
 * sync delivers what this session already remembers. Only a permanent refusal is
 * undone: the note under the key is read before staging (`previous`) and written back
 * — or removed, when there was none — because a refusal is the one answer that will
 * never change. After acceptance there is no rollback either: the provider holds the
 * note, so a mirror write that then fails leaves the staged note in place and reports
 * the bookkeeping failure. See `refusal.ts` for what a refusal does to the queue and
 * the mirror, and why each step stands on its own.
 *
 * The note is minted with its own UUID — which is also the request's client id, so the save
 * and the write that delivers it are named by one id — starts `active` under `direct` and
 * `pending` under `proposal`, and is stamped with the caller's clock. The provider is probed
 * and pushed through their deadlines as `raceTimeout` races, and its answer, never the
 * caller's guess, decides the note's final id and status.
 *
 * A key the outbox already holds a queued write for is not pushed at all: the new one joins
 * the queue behind it, so the provider receives them in the order the agent made them. That
 * order is only meaningful if two saves of the key cannot both decide it, so a mirror's saves
 * run one after another — in this process (`orderedByMirrorLocks`) and across processes (the
 * store's lock files, project and user alike). A contending save waits for the holder to
 * release (`waitForTurn`) before it stages or queues, so a holder paused before enqueueing
 * still keeps the earlier sequence; an entry for the key alone is not permission to proceed,
 * because it may predate the current holder. Only a save fenced by a sync known to this
 * process queues without staging — it leaves the mirror and index to that sync — and every
 * save that stages refreshes the index, so the next session reads the note whether or not this
 * session could deliver it.
 *
 * `forgetMemoryNote` is the other half, and it only retires a note the mirror holds: an absent
 * slug is a refusal. It declares its queue entry *before* touching the note, so the intent is
 * durable first; under `direct` the note then goes, kept aside for a refusal to put back — and
 * for an answer that is not a retire at all — and under `proposal` it stays, with the marker
 * coming from the outbox alone. It lives in `forget-handover.ts`, re-exported here, because its
 * inputs, refusals and index refresh are what `operations-support.ts` holds for both halves.
 *
 * `approveMemoryNote` is the transition a proposal waits for: a pending note is rewritten in force
 * under the caller's clock and the index is regenerated from the mirror, a note already in force is
 * returned as it stands, and a note that is history — or one this mirror does not hold — is the
 * same `MEMORY_NOTE_NOT_FOUND` refusal a forget of it would be. A note the mirror's
 * `pending-forgets.jsonl` record holds a forget for is retired instead of approved: the note is
 * deleted, its entry comes out of the record and the index is regenerated, so the answer is that
 * note, unchanged but for `status: "deleted"` — a recorded forget wins over a pending save. It asks
 * no provider and writes nothing to the queue, but it writes the mirror and the record, so it takes
 * the same ordering and the same locks a save takes. It reads the queue only to keep the index's
 * marker, and approves no queued forget: an entry the outbox still holds stays the outbox's.
 */
import { randomUUID } from "node:crypto";
import { type AgentLogger, getLogger } from "#src/infra/agent-logger";
import {
  clockOf,
  type MirrorLockInput,
  mirrorSyncInFlight,
  orderedByMirrorLocks,
  withMirrorLock,
} from "./mirror-lock.ts";
import { isMemoryPushRejected } from "./note.ts";
import {
  type MemoryOperationInput,
  type MemorySaveInput,
  type MemorySaveResult,
  noteNotFound,
  refreshIndex,
  writeRefused,
} from "./operations-support.ts";
import { createMemoryOutbox, type MemoryOutbox } from "./outbox.ts";
import type { MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import { discardRefused, restoreNote } from "./refusal.ts";
import type { MemoryStore } from "./store.ts";
import { GLOBAL_MEMORY_TIMERS, providerAnswers, raceTimeout } from "./support.ts";
import {
  MEMORY_OP_TIMEOUT_MS,
  type MemoryNote,
  type MemoryNoteStatus,
  type MemoryScope,
  type MemoryTimers,
  memoryNoteKey,
} from "./types.ts";
import { validateMemoryNoteWrite } from "./validate.ts";

/** The status a write starts in: a proposal is not in force until it is approved. */
const STATUS_BY_MODE = {
  direct: "active",
  proposal: "pending",
} as const satisfies Record<MemorySaveInput["writeMode"], MemoryNoteStatus>;

/**
 * The operations' input and result shapes live in `operations-support.ts`, with the refusals and
 * the index refresh both this file and `forget-handover.ts` need; a helper in either of those two
 * would put them in an import cycle. They are re-exported here so the module's public surface is
 * unchanged.
 */
export type {
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryOperationInput,
  MemorySaveInput,
  MemorySaveResult,
} from "./operations-support.ts";

/**
 * One approval: the note to put in force, named by its scope and slug.
 *
 * The mirror is the whole of what an approval decides: no queue to declare a write on, no provider
 * to ask, and every lock seam defaulted, so `{ store, scope, slug }` is a complete input.
 */
export interface MemoryApproveInput {
  readonly store: MemoryStore;
  readonly scope: MemoryScope;
  readonly slug: string;
  /** The clock an approved note is re-stamped from; default `() => new Date()`. */
  readonly now?: () => Date;
  /** Reported through when the lock cannot be handed back; default the host logger slot. */
  readonly logger?: AgentLogger;
  /** The timer seam the lock wait polls on; default the process globals. */
  readonly timers?: MemoryTimers;
  /** The liveness probe a lock holder is judged by; default `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
}

/** The note a write becomes: a fresh id, the mode's starting status and the caller's clock. */
function stagedNote(input: MemorySaveInput): MemoryNote {
  const { write } = input;
  return {
    id: randomUUID(),
    slug: write.slug,
    type: write.type,
    scope: write.scope,
    description: write.description,
    source: input.source,
    updatedAt: clockOf(input)().toISOString(),
    status: STATUS_BY_MODE[input.writeMode],
    body: write.body,
  };
}

/** The request one staged note is pushed as: the note's own id keys the write. */
function saveRequest(note: MemoryNote, writeMode: MemorySaveInput["writeMode"]): MemoryWriteRequest {
  return { kind: "save", clientId: note.id, scope: note.scope, slug: note.slug, writeMode, note };
}

/**
 * The post-acceptance half: record what the provider made of the note.
 *
 * Only the provider's id and status are taken from the answer — the note's own
 * source and timestamp are the caller's, and the delivery says what became of the
 * write, not when it was made. This runs after the provider has accepted the
 * write, so a failure here leaves the staged note in place: the mirror keeps the
 * note the provider holds, and the bookkeeping failure reaches the caller. Rolling
 * back instead would hand the mirror a note the provider no longer agrees with.
 */
async function recordDelivered(input: MemorySaveInput, note: MemoryNote, pushed: MemoryPushResult): Promise<void> {
  await input.store.writeNote({ ...note, id: pushed.id, status: pushed.status });
}

/** The undelivered answer: the write is on the queue, not delivered. */
function queued(note: MemoryNote): MemorySaveResult {
  return { slug: note.slug, status: note.status, delivered: false };
}

/**
 * Queue a write this save could not deliver and rebuild the index from what the mirror holds:
 * the staged note is what the mirror keeps, so the next session has to see it — whether this
 * save staged it or it was already there when this one joined the queue behind another.
 */
async function queueUnderLock(
  input: MemoryOperationInput,
  note: MemoryNote,
  request: MemoryWriteRequest,
): Promise<MemorySaveResult> {
  await input.outbox.enqueue(request);
  await refreshIndex(input);
  return queued(note);
}

/**
 * The answer for a write that is already on the queue and whose staged note the mirror
 * keeps: the entry is what makes it durable, so the index is the only thing left to rebuild.
 */
async function queuedEntryResult(input: MemoryOperationInput, note: MemoryNote): Promise<MemorySaveResult> {
  await refreshIndex(input);
  return queued(note);
}

/**
 * Queue a write another writer's mirror could not take: the entry is the only thing this
 * save writes.
 *
 * The index is not rebuilt here on purpose: rendering it from a mirror its owner is still
 * changing could publish their half-written state over the view this save refused to touch,
 * and the owner's own refresh (or the sync that delivers this entry) is the one that counts.
 * The request keeps the id the note was minted with, so the note, the entry and the write a
 * later sync sends share one client id and a replay is recognisable.
 */
async function queueFenced(
  input: MemoryOperationInput,
  note: MemoryNote,
  request: MemoryWriteRequest,
): Promise<MemorySaveResult> {
  await input.outbox.enqueue(request);
  return queued(note);
}

/**
 * Stage the note in the mirror and declare the write on the queue, while holding the lock.
 *
 * The note under the key is read first, because a permanent refusal has to be able to put it
 * back. A key the outbox already holds a queued write for is not taken any further: this
 * write joins the queue behind the one already waiting, and the order the agent wrote them
 * in survives. Otherwise the note is staged and its request goes on the queue *before* the
 * provider is asked. The lock covers both declaration and delivery, so a contending
 * save cannot take an earlier sequence even if this holder is paused before enqueueing.
 * A delivery that succeeds takes the entry back off again.
 */
async function deliverLocked(input: MemorySaveInput): Promise<MemorySaveResult> {
  const note = stagedNote(input);
  const request = saveRequest(note, input.writeMode);
  const previous = await input.store.readNote(input.write.scope, input.write.slug);
  await input.store.writeNote(note);
  if ((await input.outbox.heldKeys()).has(memoryNoteKey(note.scope, note.slug))) {
    return await queueUnderLock(input, note, request);
  }
  await input.outbox.enqueue(request);
  return await handOver(input, note, previous);
}

/**
 * Ask the provider for the note the queue already carries, and take the entry back on success.
 *
 * Anything short of an acceptance leaves the entry where it is and reports the save as
 * undelivered; the staged note stays too, because the local write is the newer fact and is
 * exactly what the queue will deliver.
 *
 * `MEMORY_PUSH_REJECTED` is the provider saying it will never take this write, so queueing it
 * would only repeat the refusal: the entry comes back off, the mirror is put back the way it
 * was, and the provider's error reaches the caller. Only the provider's answer changes the
 * note's id and status, and only after it has taken the write — the delivered arm is the one
 * arm that cannot be undone.
 */
async function handOver(
  input: MemorySaveInput,
  note: MemoryNote,
  previous: MemoryNote | null,
): Promise<MemorySaveResult> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  if (!(await providerAnswers(input.provider, timers))) return await queuedEntryResult(input, note);
  let answer: MemoryPushResult;
  try {
    answer = await raceTimeout(input.provider.push(saveRequest(note, input.writeMode)), MEMORY_OP_TIMEOUT_MS, timers);
  } catch (error) {
    if (!isMemoryPushRejected(error)) return await queuedEntryResult(input, note);
    await discardRefused(input, note.id);
    await restoreNote(input, note.scope, note.slug, previous);
    throw error;
  }
  await input.outbox.remove(note.id);
  await recordDelivered(input, note, answer);
  await refreshIndex(input);
  return { slug: note.slug, status: answer.status, delivered: true };
}

/**
 * Store one note and deliver it to the provider, or queue it for the next sync.
 *
 * The validator decides first, so a refusal leaves the store exactly as it found it.
 * Everything after it runs in the mirror's own order — one save at a time in this process
 * (`orderedByMirrorLocks`) and one writer at a time across processes (the store's locks) —
 * because the "is this key already queued?" answer, the note staged in the mirror and the
 * entry the queue takes are one decision: interleaved, they deliver in the wrong order or
 * leave the mirror on the older note.
 */
export async function saveMemoryNote(input: MemorySaveInput): Promise<MemorySaveResult> {
  const refusal = validateMemoryNoteWrite(input.write, input.source);
  if (refusal !== null) throw writeRefused(refusal);
  return await orderedByMirrorLocks(input.store, () => commitSave(input));
}

/**
 * The ordered half of a save: take the mirror's lock, and stage and declare under it.
 *
 * A mirror another writer owns is not this save's to change, and nothing is lost by
 * leaving it alone: the note goes on the outbox under its own client id, and the sync that
 * does own the mirror delivers it in sequence. Staging into a mirror someone else is
 * draining or pulling would be the very interleaving the lock is there to prevent.
 *
 * A sync in this process is the one owner that needs no wait: it queues no save of its own,
 * so this write can join the queue immediately. Any other owner has to release the lock
 * before this save stages or declares (`waitForTurn`), preserving sequence allocation even
 * when the holder is paused before enqueueing.
 */
async function commitSave(input: MemorySaveInput): Promise<MemorySaveResult> {
  if (mirrorSyncInFlight(input.store)) return await queueWithoutMirror(input);
  return await withMirrorLock(input, () => deliverLocked(input));
}

/**
 * The answer when another writer owns the mirror: the write is queued and the mirror is
 * left alone.
 *
 * Nothing is staged, so no index is rebuilt either — the mirror still holds what its owner
 * put there, and this note reaches it when a sync delivers the entry. The queue is the one
 * part of the mirror any writer may add to: an entry is a whole file written atomically,
 * named by its sequence and client id.
 */
async function queueWithoutMirror(input: MemorySaveInput): Promise<MemorySaveResult> {
  const note = stagedNote(input);
  return await queueFenced(input, note, saveRequest(note, input.writeMode));
}

/**
 * The forget half of these operations lives in `forget-handover.ts`: it is re-exported here so
 * the module, and the barrel that imports it, keep every name they published before.
 */
export { forgetMemoryNote } from "./forget-handover.ts";

/** The statuses an approval may not bring into force: a note that is already history. */
const RETIRED_STATUSES: ReadonlySet<MemoryNoteStatus> = new Set(["superseded", "rejected", "deleted"]);

/** The note one approval rewrites: the same note, in force, stamped with the caller's clock. */
function inForce(note: MemoryNote, now: () => Date): MemoryNote {
  return { ...note, status: "active", updatedAt: now().toISOString() };
}

/** The mirror's own queue, as an approval reads it: where the index's forget markers live. */
function mirrorOutbox(store: MemoryStore): MemoryOutbox {
  return createMemoryOutbox({ dir: store.paths.outboxDir });
}

/** The mirror's lock as this approval takes it: the caller's seams, else the process defaults. */
function lockInputOf(input: MemoryApproveInput): MirrorLockInput {
  return {
    store: input.store,
    logger: input.logger ?? getLogger(),
    now: input.now,
    timers: input.timers,
    isAlive: input.isAlive,
  };
}

/**
 * The locked half of an approval: read, decide and rewrite while no other writer of this
 * mirror can change the note in between — the read and the write are one decision, which is
 * the whole reason this takes the lock at all.
 *
 * A recorded pending forget is checked before the note's own status, because a pending forget
 * wins over a pending save: the note the mirror holds was written first, and the forget of it
 * came after. A note that is history, or one the mirror does not hold, is the refusal it was
 * before the record is consulted at all.
 */
async function approveLocked(input: MemoryApproveInput): Promise<MemoryNote> {
  const note = await input.store.readNote(input.scope, input.slug);
  if (note === null || RETIRED_STATUSES.has(note.status)) throw noteNotFound(input);
  if (await holdsRecordedForget(input)) return await retireRecorded(input, note);
  if (note.status === "active") return note;
  const approved = inForce(note, clockOf(input));
  await input.store.writeNote(approved);
  await refreshIndex({ store: input.store, outbox: mirrorOutbox(input.store) });
  return approved;
}

/** Whether the mirror's record holds a pending forget for the key this approval names. */
async function holdsRecordedForget(input: MemoryApproveInput): Promise<boolean> {
  const key = memoryNoteKey(input.scope, input.slug);
  const recorded = await input.store.readPendingForgets();
  return recorded.some((entry) => memoryNoteKey(entry.scope, entry.slug) === key);
}

/**
 * The note a recorded forget retires: the note goes, then its entry comes out of the record.
 *
 * That order is the failure contract: a delete that throws leaves the record holding the entry, so
 * the forget is still outstanding and still findable. The record is re-read after the delete — an
 * entry another writer appended meanwhile survives — and the note comes back as it was read, with
 * `status: "deleted"` and its own `updatedAt`: an approval retires a note, it does not rewrite one.
 */
async function retireRecorded(input: MemoryApproveInput, note: MemoryNote): Promise<MemoryNote> {
  const key = memoryNoteKey(input.scope, input.slug);
  await input.store.deleteNote(input.scope, input.slug);
  const recorded = await input.store.readPendingForgets();
  await input.store.writePendingForgets(recorded.filter((entry) => memoryNoteKey(entry.scope, entry.slug) !== key));
  await refreshIndex({ store: input.store, outbox: mirrorOutbox(input.store) });
  return { ...note, status: "deleted" };
}

/**
 * Put one pending note in force in this mirror — or retire the note a recorded forget names.
 *
 * Only the note the mirror holds is consulted, so approval is a local transition rather than an
 * authorization step: it asks no provider and writes nothing to the queue, and a forget waiting
 * there is still waiting afterwards. What it does read besides the note is the mirror's
 * pending-forget record — `pending-forgets.jsonl`, written by the local provider for a proposal
 * forget — and the queue's held keys, because the index it regenerates carries those markers.
 *
 * An entry in the record is the one thing an approval can carry out that a rewrite cannot: the note
 * is deleted, the entry is taken out of the record, the index is regenerated, and the note comes
 * back as it was read with `status: "deleted"` — its `updatedAt` still says when it was written.
 * That arm runs before the activation of a `pending` note, because a pending forget wins over a
 * pending save: the agent asked for the note to go after asking for it to exist. A delete that
 * throws leaves the entry where it is, so the next approval finds the forget again.
 *
 * The read and the rewrite are one decision, so they run under the same ordering and the same lock
 * file a save and a forget use: this is a writer of the mirror, and what it approves must be the
 * note the mirror holds now rather than a copy read before another writer's newer one landed.
 * Waiting is the right answer here, unlike a save's — an approval has no queue to put its write on.
 *
 * A note already in force, with nothing recorded against it, is returned exactly as it stands —
 * approving it again is not a rewrite, so its `updatedAt` still says when it was made active. A
 * note that is history is not a note waiting for approval, and neither is one this mirror does
 * not hold: both are `MEMORY_NOTE_NOT_FOUND`, because there is nothing to approve.
 */
export async function approveMemoryNote(input: MemoryApproveInput): Promise<MemoryNote> {
  return await orderedByMirrorLocks(input.store, () => withMirrorLock(lockInputOf(input), () => approveLocked(input)));
}
