/**
 * The built-in provider: a local mirror is its own provider, so it is always
 * reachable and never needs a network.
 *
 * A `save` lands in the store with `active` (a `direct` write) or `pending` (a
 * `proposal`, which is not in force until an approval); a `forget` deletes the
 * note under `direct` and leaves it in place under `proposal`. Both resolve the
 * id the caller can key the mirror on — the note's id for a save, the write's
 * client id for a forget, which has no note left to name. A write the store
 * cannot accept is refused as `MEMORY_PUSH_REJECTED`, never retried.
 *
 * `pull` is the empty finished page: the mirror is the store the caller already
 * reads, so there is nothing to pull back into it. There is no `search`; keyword
 * search runs over the mirror through `searchMemoryNotes`.
 */
import { NaxError } from "#src/infra/nax-error";
import type { MemoryPage, MemoryProvider, MemoryPushResult, MemoryWriteRequest } from "./provider-types.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryNoteStatus } from "./types.ts";

const ERROR_STAGE = "memory";

/** The status a write lands with: a proposal is not in force until an approval. */
const WRITE_MODE_STATUS = {
  direct: "active",
  proposal: "pending",
} as const satisfies Record<MemoryWriteRequest["writeMode"], MemoryNoteStatus>;

function pushRejected(message: string): NaxError {
  return new NaxError(message, "MEMORY_PUSH_REJECTED", { stage: ERROR_STAGE });
}

export function createLocalMemoryProvider(store: MemoryStore): MemoryProvider {
  /** A save is accepted by definition: the mirror is what the provider is. */
  async function save(request: MemoryWriteRequest): Promise<MemoryPushResult> {
    const note = request.note;
    if (note === undefined) throw pushRejected(`memory save for "${request.slug}" carries no note`);
    const status = WRITE_MODE_STATUS[request.writeMode];
    await store.writeNote({ ...note, status });
    return { id: note.id, status };
  }
  /** A forget under direct removes the note; a proposal leaves it for an approval. */
  async function forget(request: MemoryWriteRequest): Promise<MemoryPushResult> {
    const direct = request.writeMode === "direct";
    if (direct) await store.deleteNote(request.scope, request.slug);
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
