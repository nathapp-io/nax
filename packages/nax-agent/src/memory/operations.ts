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
 * the bookkeeping failure.
 *
 * The note is minted with its own UUID, starts `active` under `direct` and
 * `pending` under `proposal`, and is stamped with the caller's clock. That UUID
 * is the request's client id, so the save and the write that delivers it are
 * named by one id. The provider is then probed through the probe deadline and
 * pushed through the operation deadline, both as `raceTimeout` races, and its
 * answer — never the caller's guess — decides the note's final id and status.
 *
 * A key the outbox already holds a queued write for is not pushed at all: the new
 * write joins the queue behind the waiting one, so the provider receives them in the
 * order the agent made them. That order is only meaningful if two saves of the key
 * cannot both decide it, so a mirror's saves run one after another: in this process
 * through `orderedByStore`, and across processes through the store's own lock file —
 * the artifact that already means "this mirror has one writer". A save that ends up
 * undelivered declares its queue entry before it asks the provider. A contending save
 * waits for the holder to release the lock (`waitForTurn`) before it stages or queues,
 * so even a holder paused before enqueueing keeps the earlier sequence. An entry for
 * the key alone is not permission to proceed: it might predate the current holder.
 * Only a save fenced by a sync known to this process queues without staging; it leaves
 * the mirror and index to that sync. Every save that stages refreshes the index, so the
 * next session reads the note whether or not this session could deliver it.
 *
 * `forgetMemoryNote` is the other half, and it only retires a note the mirror holds: an absent
 * slug is a refusal. Under `direct` the note goes first, kept aside for a refusal to put back;
 * under `proposal` it stays, and the marker comes from the outbox alone.
 *
 * `approveMemoryNote` is the transition a proposal waits for: a pending note is rewritten in force
 * under the caller's clock and the index is regenerated from the mirror, a note already in force is
 * returned as it stands, and a note that is history — or one this mirror does not hold — is the
 * same `MEMORY_NOTE_NOT_FOUND` refusal a forget of it would be. It asks no provider and writes
 * nothing to the queue, but it is still a writer of the mirror: what it rewrites must be the note
 * the mirror holds now, so it takes the same ordering and the same lock a save takes. What it reads
 * from the queue is the held-forget set, because the index it renders carries that marker and this
 * operation must not drop it. It approves no queued forget: the entry stays the outbox's.
 */
import { randomUUID } from "node:crypto";
import { type AgentLogger, getLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { refreshMemoryIndex } from "./index-render.ts";
import { clockOf, type MirrorLockInput, orderedByStore, withMirrorLock } from "./mirror-lock.ts";
import { isMemoryPushRejected } from "./note.ts";
import { createMemoryOutbox, type MemoryOutbox } from "./outbox.ts";
import type { MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import type { MemoryStore } from "./store.ts";
import { GLOBAL_MEMORY_TIMERS, providerAnswers, raceTimeout, warnQuietly } from "./sync.ts";
import { syncInFlight } from "./sync-flight.ts";
import {
  MEMORY_OP_TIMEOUT_MS,
  type MemoryNote,
  type MemoryNoteStatus,
  type MemoryNoteWrite,
  type MemoryScope,
  type MemoryTimers,
  type MemoryWriteRefusal,
  memoryNoteKey,
} from "./types.ts";
import { validateMemoryNoteWrite } from "./validate.ts";

const ERROR_STAGE = "memory";

/** The status a write starts in: a proposal is not in force until it is approved. */
const STATUS_BY_MODE = {
  direct: "active",
  proposal: "pending",
} as const satisfies Record<MemorySaveInput["writeMode"], MemoryNoteStatus>;

/** The status a forget rests in with no provider answer: retired, or still awaiting approval. */
const FORGET_STATUS_BY_MODE = {
  direct: "deleted",
  proposal: "pending",
} as const satisfies Record<MemoryForgetInput["writeMode"], MemoryNoteStatus>;

/** What every operation is given: the mirror it writes, the queue and the provider it talks to. */
export interface MemoryOperationInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProvider;
  /**
   * Reported through when the save cannot be undone; the other outcomes say what
   * became of the write in the result, so a delivered save has nothing to say.
   */
  readonly logger: AgentLogger;
  /** The clock a note is stamped from; default `() => new Date()`. */
  readonly now?: () => Date;
  /** The timer seam the probe and the push race against; default the process globals. */
  readonly timers?: MemoryTimers;
  /** The liveness probe a lock holder is judged by; default `isProcessAlive`. */
  readonly isAlive?: (pid: number) => boolean;
}

/** One save: the write to store, the mode it is stored in, and the label it is stored under. */
export interface MemorySaveInput extends MemoryOperationInput {
  readonly write: MemoryNoteWrite;
  /** `direct` takes effect at once; `proposal` is held pending until it is approved. */
  readonly writeMode: "direct" | "proposal";
  /** The one-line label the note records as its `source` (`"nax-chat"`, `"nax-run"`, ...). */
  readonly source: string;
}

/** What a save came to: the note's slug, the status it ended in, and whether a provider took it. */
export interface MemorySaveResult {
  readonly slug: string;
  readonly status: MemoryNoteStatus;
  readonly delivered: boolean;
}

/** One forget: the note to retire, why, and the mode it is retired in. */
export interface MemoryForgetInput extends MemoryOperationInput {
  readonly scope: MemoryScope;
  readonly slug: string;
  readonly reason: string;
  /** `direct` retires the note at once; `proposal` asks for approval and leaves it in place. */
  readonly writeMode: "direct" | "proposal";
}

/** What a forget came to: the slug it names, the status it ended in, and whether it was delivered. */
export interface MemoryForgetResult {
  readonly slug: string;
  readonly status: MemoryNoteStatus;
  readonly delivered: boolean;
}

/**
 * One approval: the note to put in force, named by its scope and slug.
 *
 * The mirror is the whole of what an approval decides, so it is given no queue to declare a
 * write on and no provider to ask. It is given the seams its lock wait runs on, because the
 * note it rewrites has to be the note the mirror holds at that moment — and every one of them
 * has a default, so `{ store, scope, slug }` is a complete input.
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

/** The refusal a rejected write is thrown as: the validator's reason as the message, its field as context. */
function writeRefused(refusal: MemoryWriteRefusal): NaxError {
  return new NaxError(refusal.reason, "MEMORY_WRITE_REFUSED", { stage: ERROR_STAGE, field: refusal.field });
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

/**
 * Regenerate the indexes from what the store now holds, so the next session reads this write.
 *
 * The queue is read for the notes whose forget is still waiting: that marker is the outbox
 * speaking, and an index rendered without it would report a retire that is still in flight as
 * though it had never been asked for.
 */
async function refreshIndex(input: { readonly store: MemoryStore; readonly outbox: MemoryOutbox }): Promise<void> {
  await refreshMemoryIndex(input.store, { heldForgets: await input.outbox.heldKeys("forget") });
}

/** The undelivered answer: the write is on the queue, not delivered. */
function queued(note: MemoryNote): MemorySaveResult {
  return { slug: note.slug, status: note.status, delivered: false };
}

/**
 * Queue a write this save could not deliver, and rebuild the index from what the mirror
 * holds.
 *
 * The staged note is what the mirror keeps, so the session that reads the index next has to
 * see it — whether it was staged by this save or was already there when this one joined the
 * queue behind it.
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
 * The index is not rebuilt here on purpose. It would be rendered from a mirror that its
 * owner is still changing, so rebuilding it could publish their half-written state over the
 * view this save just refused to touch. The owner's own refresh is the one that counts, and
 * the sync that delivers this entry refreshes it either way.
 *
 * The request keeps the id the note was minted with, so the note, the entry and the write a
 * later sync sends are named by one client id — the provider can recognise a replay of
 * something it already took.
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
 * Undo the staged write: the note that was under the key before, or no note at all.
 *
 * A rollback that fails is reported, never thrown: the caller is owed the provider's
 * refusal, and a second error raised here would replace it. The mirror is then left
 * holding the refused note, which is the one case worth a warning of its own.
 */
async function restoreNote(input: MemorySaveInput, note: MemoryNote, previous: MemoryNote | null): Promise<void> {
  try {
    if (previous === null) await input.store.deleteNote(note.scope, note.slug);
    else await input.store.writeNote(previous);
  } catch (error) {
    warnQuietly(input.logger, "memory save could not restore the previous note", {
      path: input.store.paths.notesDir,
      slug: note.slug,
      error: errorMessage(error),
    });
  }
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
 * The provider is probed and then pushed, each through its own deadline, and anything short
 * of an acceptance — a probe that answered `false`, threw or timed out; a push that did the
 * same — leaves the entry where it is and reports the save as undelivered. The staged note
 * stays too: the local write is the newer fact, and it is exactly what the queue will
 * deliver.
 *
 * `MEMORY_PUSH_REJECTED` is the provider saying it will never take this write, so queueing
 * it would only repeat the refusal: the entry comes back off, the mirror is put back the way
 * it was, and the provider's error reaches the caller. Only the provider's answer changes
 * the note's id and status, and only after the provider has taken it — the delivered arm is
 * the one arm that cannot be undone.
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
    await input.outbox.remove(note.id);
    await restoreNote(input, note, previous);
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
 * (`orderedByStore`) and one writer at a time across processes (the store's lock) —
 * because none of it means anything if two saves compute it at the same time: the "is
 * this key already queued?" answer, the note staged in the mirror and the entry the queue
 * takes are one decision, and two of them interleaved can be delivered in the wrong order
 * or leave the mirror on the older note.
 */
export async function saveMemoryNote(input: MemorySaveInput): Promise<MemorySaveResult> {
  const refusal = validateMemoryNoteWrite(input.write, input.source);
  if (refusal !== null) throw writeRefused(refusal);
  return await orderedByStore(input.store.paths.lock, () => commitSave(input));
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
  const lockPath = input.store.paths.lock;
  if (syncInFlight(lockPath)) return await queueWithoutMirror(input);
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

/** The note an operation names: the two fields the not-found refusal is spelled from. */
interface MemoryNoteRef {
  readonly scope: MemoryScope;
  readonly slug: string;
}

/** The refusal a note this mirror does not hold — or one that is history — is thrown as. */
function noteNotFound(input: MemoryNoteRef): NaxError {
  return new NaxError(
    `memory note "${memoryNoteKey(input.scope, input.slug)}" is not in this mirror`,
    "MEMORY_NOTE_NOT_FOUND",
    { stage: ERROR_STAGE, scope: input.scope, slug: input.slug },
  );
}

/** The request one forget is pushed as: its own UUID keys the write, and the reason rides along. */
function forgetRequest(input: MemoryForgetInput): MemoryWriteRequest {
  const { scope, slug, writeMode, reason } = input;
  return { kind: "forget", clientId: randomUUID(), scope, slug, writeMode, reason };
}

/** Queue a forget this operation could not deliver, and rebuild the index so its marker shows. */
async function queueForget(input: MemoryForgetInput, request: MemoryWriteRequest): Promise<MemoryForgetResult> {
  await input.outbox.enqueue(request);
  await refreshIndex(input);
  return { slug: input.slug, status: FORGET_STATUS_BY_MODE[input.writeMode], delivered: false };
}

/** Put a retired note back; a failure is reported, never thrown, so the refusal still reaches the caller. */
async function restoreForgotten(input: MemoryForgetInput, previous: MemoryNote): Promise<void> {
  try {
    await input.store.writeNote(previous);
  } catch (error) {
    warnQuietly(input.logger, "memory forget could not restore the note", {
      path: input.store.paths.notesDir,
      slug: previous.slug,
      error: errorMessage(error),
    });
  }
}

/**
 * The ordered half of a forget: join a sync that owns the mirror, or take the lock and decide
 * under it. Nothing is read from the mirror before the lock is held, so what a forget retires
 * and what the queue is asked about are both the mirror's current answer rather than a stale one.
 */
async function commitForget(input: MemoryForgetInput): Promise<MemoryForgetResult> {
  const request = forgetRequest(input);
  if (syncInFlight(input.store.paths.lock)) return await queueFencedForget(input, request);
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

/** Retire the note and declare the request, while the mirror's lock is held. */
async function forgetLocked(input: MemoryForgetInput, request: MemoryWriteRequest): Promise<MemoryForgetResult> {
  const previous = await input.store.readNote(input.scope, input.slug);
  if (previous === null) throw noteNotFound(input);
  if (input.writeMode === "direct") await input.store.deleteNote(input.scope, input.slug);
  if ((await input.outbox.heldKeys()).has(memoryNoteKey(input.scope, input.slug))) {
    return await queueForget(input, request);
  }
  return await handOverForget(input, previous, request);
}

/** Ask the provider to forget the note; anything short of an acceptance queues the request. */
async function handOverForget(
  input: MemoryForgetInput,
  previous: MemoryNote,
  request: MemoryWriteRequest,
): Promise<MemoryForgetResult> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  if (!(await providerAnswers(input.provider, timers))) return await queueForget(input, request);
  let answer: MemoryPushResult;
  try {
    answer = await raceTimeout(input.provider.push(request), MEMORY_OP_TIMEOUT_MS, timers);
  } catch (error) {
    if (!isMemoryPushRejected(error)) return await queueForget(input, request);
    if (input.writeMode === "direct") await restoreForgotten(input, previous);
    throw error;
  }
  await refreshIndex(input);
  return { slug: input.slug, status: answer.status, delivered: true };
}

/**
 * Forget one note: retire it in the mirror and tell the provider, or queue the request.
 *
 * A mirror another writer owns is not this forget's to change, so it is coordinated exactly as
 * a save is: this process's chain (`orderedByStore`) orders the forgets and saves of one mirror,
 * and the store's lock file orders them across processes. Without the lock a forget could delete
 * a note while another process's save restored or overwrote it, and the queue's order would
 * describe writes that never happened in that order. A permanent refusal is the one answer
 * undone, under `direct`, and it is rethrown; an absent slug is never queued.
 */
export async function forgetMemoryNote(input: MemoryForgetInput): Promise<MemoryForgetResult> {
  return await orderedByStore(input.store.paths.lock, () => commitForget(input));
}

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

/**
 * The mirror's lock as this approval takes it: the caller's seam where it gave one, and the
 * process defaults — including the logger slot — where it did not.
 */
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
 * mirror can change the note in between.
 *
 * The read and the write have to be one decision — that is the whole reason this takes the
 * lock at all — so a note another writer replaced while this waited is the note that gets
 * approved, never the copy this operation would otherwise have read before the wait.
 */
async function approveLocked(input: MemoryApproveInput): Promise<MemoryNote> {
  const note = await input.store.readNote(input.scope, input.slug);
  if (note === null || RETIRED_STATUSES.has(note.status)) throw noteNotFound(input);
  if (note.status === "active") return note;
  const approved = inForce(note, clockOf(input));
  await input.store.writeNote(approved);
  await refreshIndex({ store: input.store, outbox: mirrorOutbox(input.store) });
  return approved;
}

/**
 * Put one pending note in force in this mirror.
 *
 * Only the note the mirror holds is consulted, so approval is a local transition rather than an
 * authorization step: it asks no provider and writes nothing to the queue, and a forget waiting
 * on that queue is still waiting afterwards. What it does read from the queue is the set of
 * notes whose forget is queued, because the index it regenerates carries that marker and an
 * index rendered without it would report a still-pending retire as though it had never been
 * asked for.
 *
 * The read and the rewrite are one decision, so they run under the same ordering and the same
 * lock file a save and a forget use: this is a writer of the mirror, and what it approves must
 * be the note the mirror holds now rather than a copy read before another writer's newer one
 * landed. Waiting is the right answer here, unlike a save's — an approval has no queue to put
 * its write on, so it has to be the writer when it reads.
 *
 * A note already in force is returned exactly as it stands — approving it again is not a
 * rewrite, so its `updatedAt` still says when it was made active. A note that is history is not
 * a note waiting for approval, and neither is one this mirror does not hold: both are
 * `MEMORY_NOTE_NOT_FOUND`, because there is nothing to approve.
 */
export async function approveMemoryNote(input: MemoryApproveInput): Promise<MemoryNote> {
  return await orderedByStore(input.store.paths.lock, () =>
    withMirrorLock(lockInputOf(input), () => approveLocked(input)),
  );
}
