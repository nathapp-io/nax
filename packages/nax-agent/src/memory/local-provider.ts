/**
 * The built-in provider: a local mirror is its own provider, so it is always
 * reachable and never needs a network.
 *
 * A `save` lands in the store with `active` (a `direct` write) or `pending` (a
 * `proposal`, which is not in force until an approval); a `forget` deletes the
 * note under `direct` and leaves it in place under `proposal`. Both resolve the
 * id the caller can key the mirror on — the note's id for a save, the write's
 * client id for a forget, which has no note left to name.
 *
 * A proposal forget is the one write the mirror cannot carry out, so it is queued in
 * the store's `pending-forgets.jsonl` instead: the record is what an index refresh and
 * an approval read later, in a process that never saw the request. A `direct` forget or
 * a save of that key takes the entry back out — the mirror then holds what was asked
 * for. Nothing else may write the record on this provider's behalf.
 *
 * A write the store can never accept — an unslugged note, a scope this store does not
 * have, a target outside it — is refused as `MEMORY_PUSH_REJECTED`, never retried.
 * A failure that a retry can fix (a permission error, a full disk) is left as it is,
 * including one from the record write: the operation keeps the write queued and a
 * later sync replays it.
 *
 * `pull` is the empty finished page: the mirror is the store the caller already
 * reads, so there is nothing to pull back into it. There is no `search`; keyword
 * search runs over the mirror through `searchMemoryNotes`.
 */
import { NaxError } from "#src/infra/nax-error";
import type { MemoryPage, MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import type { MemoryStore } from "./store.ts";
import { type MemoryNoteStatus, type MemoryPendingForget, memoryNoteKey } from "./types.ts";

const ERROR_STAGE = "memory";

/** The status a write lands with: a proposal is not in force until an approval. */
const WRITE_MODE_STATUS = {
  direct: "active",
  proposal: "pending",
} as const satisfies Record<MemoryWriteRequest["writeMode"], MemoryNoteStatus>;

/**
 * The store's own refusal codes: the write can never be accepted, so a retry
 * cannot help. Everything else the store throws is I/O and stays retryable.
 */
const PERMANENT_STORE_CODES: ReadonlySet<string> = new Set([
  "MEMORY_PATH_OUTSIDE",
  "MEMORY_SCOPE_UNAVAILABLE",
  "MEMORY_SLUG_INVALID",
]);

function pushRejected(message: string): NaxError {
  return new NaxError(message, "MEMORY_PUSH_REJECTED", { stage: ERROR_STAGE });
}

/** A permanent store refusal as a provider rejection; anything else passes through. */
function pushRejectedFrom(error: unknown): unknown {
  if (!(error instanceof NaxError) || !PERMANENT_STORE_CODES.has(error.code)) return error;
  return new NaxError(error.message, "MEMORY_PUSH_REJECTED", {
    stage: ERROR_STAGE,
    storeCode: error.code,
    cause: error,
  });
}

/** Run one store mutation, so a permanent refusal reaches the caller in the contract's code. */
async function throughStore(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    throw pushRejectedFrom(error);
  }
}

/** The entry a proposal forget leaves in the record: the request's own id and reason. */
function queuedForget(request: MemoryWriteRequest): MemoryPendingForget {
  return { clientId: request.clientId, scope: request.scope, slug: request.slug, reason: request.reason ?? "" };
}

/** Whether rewriting the record would change it: an unchanged list is not written back. */
function sameEntries(before: readonly MemoryPendingForget[], after: readonly MemoryPendingForget[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((entry, index) => {
    const other = after[index];
    return (
      other !== undefined &&
      entry.clientId === other.clientId &&
      entry.scope === other.scope &&
      entry.slug === other.slug &&
      entry.reason === other.reason
    );
  });
}

/**
 * The record rewritten without `key`'s entry, and with `queued` appended after the
 * others when a proposal forget is what took the entry out. The store validates the
 * slugs it is handed, so a forget of a slug no note can carry is refused here — before
 * anything is recorded — even though a proposal never reaches the notes themselves.
 */
async function rewriteRecord(store: MemoryStore, key: string, queued: MemoryPendingForget | null): Promise<void> {
  const entries = await store.readPendingForgets();
  const kept = entries.filter((entry) => memoryNoteKey(entry.scope, entry.slug) !== key);
  const next = queued === null ? kept : [...kept, queued];
  // A key the record does not hold leaves the file alone: absent stays absent.
  if (sameEntries(entries, next)) return;
  await store.writePendingForgets(next);
}

export function createLocalMemoryProvider(store: MemoryStore): MemoryProvider {
  /** A save is accepted by definition: the mirror is what the provider is. */
  async function save(request: MemoryWriteRequest): Promise<MemoryPushResult> {
    const note = request.note;
    if (note === undefined) throw pushRejected(`memory save for "${request.slug}" carries no note`);
    const status = WRITE_MODE_STATUS[request.writeMode];
    await throughStore(() => store.writeNote({ ...note, status }));
    // Saving the slug again means it is wanted, so whatever forget it was queued for goes.
    const key = memoryNoteKey(note.scope, note.slug);
    await throughStore(() => rewriteRecord(store, key, null));
    return { id: note.id, status };
  }
  /** A forget under direct removes the note; a proposal leaves it for an approval. */
  async function forget(request: MemoryWriteRequest): Promise<MemoryPushResult> {
    const direct = request.writeMode === "direct";
    if (direct) await throughStore(() => store.deleteNote(request.scope, request.slug));
    const key = memoryNoteKey(request.scope, request.slug);
    await throughStore(() => rewriteRecord(store, key, direct ? null : queuedForget(request)));
    return { id: request.clientId, status: direct ? "deleted" : "pending" };
  }
  return {
    id: "local",
    pull: async (): Promise<MemoryPage> => ({ notes: [], done: true }),
    push: async (request) => (request.kind === "save" ? save(request) : forget(request)),
    // A local mirror has no network to be unreachable.
    reachable: async () => true,
  };
}
