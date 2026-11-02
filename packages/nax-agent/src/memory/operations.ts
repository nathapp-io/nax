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
 * A write that passes is staged in the mirror before any provider is asked,
 * because the mirror is the durable fact: the note is minted with its own UUID,
 * starts `active` under `direct` and `pending` under `proposal`, and is stamped
 * with the caller's clock. That UUID is the request's client id, so the save and
 * the write that delivers it are named by one id. The provider is then probed
 * through the probe deadline and pushed through the operation deadline, both as
 * `raceTimeout` races, and its answer — never the caller's guess — decides the
 * note's final id and status.
 *
 * Only the delivered path is here. A provider that does not answer, and a push
 * that fails or times out, is reported by throwing: the note is already in the
 * mirror, so the local fact survives, and queueing the write behind the outbox
 * belongs to the undelivered path rather than to this one.
 */
import { randomUUID } from "node:crypto";
import type { AgentLogger } from "#src/infra/agent-logger";
import { NaxError } from "#src/infra/nax-error";
import { refreshMemoryIndex } from "./index-render.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import type { MemoryStore } from "./store.ts";
import { GLOBAL_MEMORY_TIMERS, providerAnswers, raceTimeout } from "./sync.ts";
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
  /** Reported through on the paths that cannot deliver; a delivered save has nothing to say. */
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

function unreachable(slug: string): NaxError {
  return new NaxError(
    `memory provider did not answer; "${slug}" is stored locally and was not delivered`,
    "MEMORY_UNREACHABLE",
    { stage: ERROR_STAGE, slug },
  );
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
 * Hand one staged note to the provider, then write what it made of the note back.
 *
 * The provider is asked whether it answers before it is asked to store anything,
 * and both calls are bounded by their deadline: a provider that has stopped
 * answering must not hold the caller open. Only the provider's id and status are
 * taken from the answer — the note's own source and timestamp are the caller's,
 * and the delivery says what became of the write, not when it was made.
 */
async function deliver(input: MemorySaveInput, note: MemoryNote): Promise<MemoryPushResult> {
  const timers = input.timers ?? GLOBAL_MEMORY_TIMERS;
  if (!(await providerAnswers(input.provider, timers))) throw unreachable(note.slug);
  const pushed = await raceTimeout(
    input.provider.push(saveRequest(note, input.writeMode)),
    MEMORY_OP_TIMEOUT_MS,
    timers,
  );
  await input.store.writeNote({ ...note, id: pushed.id, status: pushed.status });
  return pushed;
}

/** Regenerate the indexes from what the store now holds, so the next session reads this save. */
async function refreshIndex(input: MemoryOperationInput): Promise<void> {
  await refreshMemoryIndex(input.store, { heldForgets: await input.outbox.heldKeys("forget") });
}

/**
 * Store one note and deliver it to the provider.
 *
 * The order is the contract: the validator decides first, so a refusal leaves the
 * store exactly as it found it; the note is then mirrored, because the local fact
 * must survive whatever the provider answers; and only then is the provider asked,
 * its answer written back over the note's id and status. The indexes are rebuilt
 * before the call settles, so the session that reads them next sees this save.
 */
export async function saveMemoryNote(input: MemorySaveInput): Promise<MemorySaveResult> {
  const refusal = validateMemoryNoteWrite(input.write, input.source);
  if (refusal !== null) throw writeRefused(refusal);
  const note = stagedNote(input);
  await input.store.writeNote(note);
  const answer = await deliver(input, note);
  await refreshIndex(input);
  return { slug: note.slug, status: answer.status, delivered: true };
}
