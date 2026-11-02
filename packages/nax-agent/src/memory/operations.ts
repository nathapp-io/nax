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
 * order the agent made them. Every path that returns refreshes the index, so the next
 * session reads the note whether or not this session could deliver it.
 */
import { randomUUID } from "node:crypto";
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { refreshMemoryIndex } from "./index-render.ts";
import { isMemoryPushRejected } from "./note.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import type { MemoryStore } from "./store.ts";
import { GLOBAL_MEMORY_TIMERS, providerAnswers, raceTimeout, warnQuietly } from "./sync.ts";
import {
  MEMORY_OP_TIMEOUT_MS,
  type MemoryNote,
  type MemoryNoteStatus,
  type MemoryNoteWrite,
  type MemoryTimers,
  type MemoryWriteRefusal,
} from "./types.ts";
import { validateMemoryNoteWrite } from "./validate.ts";

const ERROR_STAGE = "memory";

/** The status a write starts in: a proposal is not in force until it is approved. */
const STATUS_BY_MODE = {
  direct: "active",
  proposal: "pending",
} as const satisfies Record<MemorySaveInput["writeMode"], MemoryNoteStatus>;

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

/** The refusal a rejected write is thrown as: the validator's reason as the message, its field as context. */
function writeRefused(refusal: MemoryWriteRefusal): NaxError {
  return new NaxError(refusal.reason, "MEMORY_WRITE_REFUSED", { stage: ERROR_STAGE, field: refusal.field });
}

/** The note a write becomes: a fresh id, the mode's starting status and the caller's clock. */
function stagedNote(input: MemorySaveInput): MemoryNote {
  const now = input.now ?? (() => new Date());
  const { write } = input;
  return {
    id: randomUUID(),
    slug: write.slug,
    type: write.type,
    scope: write.scope,
    description: write.description,
    source: input.source,
    updatedAt: now().toISOString(),
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

/** Regenerate the indexes from what the store now holds, so the next session reads this save. */
async function refreshIndex(input: MemoryOperationInput): Promise<void> {
  await refreshMemoryIndex(input.store, { heldForgets: await input.outbox.heldKeys("forget") });
}

/** The note's key as the outbox names it: one queued write per key is the one still undelivered. */
function keyOf(note: MemoryNote): string {
  return `${note.scope}/${note.slug}`;
}

/**
 * The undelivered answer: the mirror already holds the note, and the queue now holds the write.
 *
 * The request keeps the id the note was staged with, so the note, the entry and the
 * write a later sync sends are named by one client id — the provider can recognise a
 * replay of something it already took.
 */
async function queueUndelivered(
  input: MemoryOperationInput,
  note: MemoryNote,
  request: MemoryWriteRequest,
): Promise<MemorySaveResult> {
  await input.outbox.enqueue(request);
  return { slug: note.slug, status: note.status, delivered: false };
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
 * Hand the staged note to the provider, or leave it on the queue.
 *
 * A key the outbox already holds a queued write for is not pushed at all: the provider
 * would receive this write ahead of the one already waiting, so the new write joins the
 * queue behind it and the order the agent wrote them in survives. Otherwise the provider
 * is probed and then pushed, each through its own deadline, and anything short of an
 * acceptance — a probe that answered `false`, threw or timed out; a push that did the
 * same — queues the same request under the same client id and reports the save as
 * undelivered.
 *
 * The two failures are not the same fact. A transient one leaves the staged note in the
 * mirror, because the local write is the newer fact and it is exactly what the queue will
 * deliver. `MEMORY_PUSH_REJECTED` is the provider saying it will never take this write,
 * so queueing it would only repeat the refusal: the mirror is put back the way it was and
 * the provider's error reaches the caller. Only the provider's answer changes the note's
 * id and status, and only after the provider has taken it — the delivered arm is the one
 * arm that cannot be undone.
 */
async function deliverOrQueue(
  input: MemorySaveInput,
  note: MemoryNote,
  previous: MemoryNote | null,
): Promise<MemorySaveResult> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  const request = saveRequest(note, input.writeMode);
  if ((await input.outbox.heldKeys()).has(keyOf(note))) return await queueUndelivered(input, note, request);
  if (!(await providerAnswers(input.provider, timers))) return await queueUndelivered(input, note, request);
  let answer: MemoryPushResult;
  try {
    answer = await raceTimeout(input.provider.push(request), MEMORY_OP_TIMEOUT_MS, timers);
  } catch (error) {
    if (!isMemoryPushRejected(error)) return await queueUndelivered(input, note, request);
    await restoreNote(input, note, previous);
    throw error;
  }
  await recordDelivered(input, note, answer);
  return { slug: note.slug, status: answer.status, delivered: true };
}

/**
 * Store one note and deliver it to the provider, or queue it for the next sync.
 *
 * The order is the contract: the validator decides first, so a refusal leaves the
 * store exactly as it found it; the note under the key is read next, because a
 * permanent refusal has to be able to put it back; the note is then mirrored and
 * handed over, and however that ends the indexes are rebuilt, so the session that
 * reads them next sees this save.
 */
export async function saveMemoryNote(input: MemorySaveInput): Promise<MemorySaveResult> {
  const refusal = validateMemoryNoteWrite(input.write, input.source);
  if (refusal !== null) throw writeRefused(refusal);
  const previous = await input.store.readNote(input.write.scope, input.write.slug);
  const note = stagedNote(input);
  await input.store.writeNote(note);
  const result = await deliverOrQueue(input, note, previous);
  await refreshIndex(input);
  return result;
}
