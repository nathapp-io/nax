/**
 * What a permanent refusal undoes, and in which order.
 *
 * A provider that refuses a write will refuse it again, so the guards a write relies on
 * while it might still be delivered come off here: the request leaves the queue and the
 * mirror goes back to the note it held before the write staged. Both are *consequences* of
 * the refusal, not alternatives to it, so neither step can decide whether the other runs —
 * and neither can replace the error the caller is owed. A queue entry left behind is
 * refused again by the next sync and costs a line; a note nobody put back costs the mirror
 * a fact it held.
 *
 * It lives apart from the operations because both halves of a refusal — a save's and a
 * forget's — need exactly this and nothing of each other's.
 */
import type { AgentLogger } from "#src/infra/agent-logger";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryStore } from "./store.ts";
import { bookkeeping } from "./support.ts";
import type { MemoryNote, MemoryScope } from "./types.ts";

/** What a refusal needs of an operation's inputs: the mirror it restores and where it reports. */
export interface RefusalInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly logger: AgentLogger;
}

/** Take a refused write back off the queue, whatever the queue does. */
export async function discardRefused(input: RefusalInput, clientId: string): Promise<void> {
  const data = { path: input.store.paths.outboxDir, clientId };
  const remove = () => input.outbox.remove(clientId);
  await bookkeeping(input.logger, "memory operation could not take a refused write off the queue", data, remove);
}

/**
 * Undo a refused save: the note that was under the key before, or no note at all.
 *
 * A rollback that fails is reported, never thrown: the caller is owed the provider's
 * refusal, and a second error raised here would replace it. The mirror is then left
 * holding the refused note, which is the one case worth a warning of its own.
 */
export async function restoreNote(
  input: RefusalInput,
  scope: MemoryScope,
  slug: string,
  previous: MemoryNote | null,
): Promise<void> {
  const data = { path: input.store.paths.notesDir, slug };
  const restore = () => (previous === null ? input.store.deleteNote(scope, slug) : input.store.writeNote(previous));
  await bookkeeping(input.logger, "memory save could not restore the previous note", data, restore);
}

/**
 * Put a refused forget's note back; a failure is reported, never thrown, for the same reason.
 *
 * It answers whether the note is back in the mirror. The caller needs that answer, not out of
 * interest in the logging: the entry naming the note is already off the queue, so a write back
 * that did not land leaves nothing local that knows about the note, and the pull is the only
 * route left to it.
 */
export async function restoreForgotten(input: RefusalInput, previous: MemoryNote): Promise<boolean> {
  const data = { path: input.store.paths.notesDir, slug: previous.slug };
  const rewrite = () => input.store.writeNote(previous);
  return await bookkeeping(input.logger, "memory forget could not restore the note", data, rewrite);
}
