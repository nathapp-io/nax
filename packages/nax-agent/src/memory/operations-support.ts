/**
 * What the memory operations share: their inputs, the refusals they throw and the index they
 * render.
 *
 * It is a leaf on purpose. `operations.ts` (the save and the approval) and `forget-handover.ts`
 * (the forget and its hand-over) both need these, and each imports the other's module — so a
 * helper living in either would put the two in an import cycle, which `check-import-cycles`
 * fails. Nothing here imports a sibling operation module.
 *
 * What belongs here is only what both halves genuinely read the same way: the input shapes a
 * caller passes, the two errors a refusal is spelled as, and the index refresh a write finishes
 * with. What a *forget* answers with in its own arms stays with the forget.
 */
import type { AgentLogger } from "#src/infra/agent-logger";
import { NaxError } from "#src/infra/nax-error";
import { refreshMemoryIndex } from "./index-render.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryProvider } from "./provider-types.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryNoteStatus, MemoryNoteWrite, MemoryScope, MemoryTimers, MemoryWriteRefusal } from "./types.ts";
import { memoryNoteKey } from "./types.ts";

const ERROR_STAGE = "memory";

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

/** The refusal a rejected write is thrown as: the validator's reason as the message, its field as context. */
export function writeRefused(refusal: MemoryWriteRefusal): NaxError {
  return new NaxError(refusal.reason, "MEMORY_WRITE_REFUSED", { stage: ERROR_STAGE, field: refusal.field });
}

/** The note an operation names: the two fields the not-found refusal is spelled from. */
export interface MemoryNoteRef {
  readonly scope: MemoryScope;
  readonly slug: string;
}

/** The refusal a note this mirror does not hold — or one that is history — is thrown as. */
export function noteNotFound(input: MemoryNoteRef): NaxError {
  return new NaxError(
    `memory note "${memoryNoteKey(input.scope, input.slug)}" is not in this mirror`,
    "MEMORY_NOTE_NOT_FOUND",
    { stage: ERROR_STAGE, scope: input.scope, slug: input.slug },
  );
}

/**
 * Regenerate the indexes from what the store now holds, so the next session reads this write.
 *
 * The queue is read for the notes whose forget is still waiting: that marker is the outbox
 * speaking, and an index rendered without it would report a retire that is still in flight as
 * though it had never been asked for.
 *
 * It is called *after* the mirror is in its final shape, never before: an index rendered from a
 * mirror that still lacks the note a held forget put back would drop the note from the view the
 * next session reads, whatever the mirror itself holds.
 */
export async function refreshIndex(input: {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
}): Promise<void> {
  await refreshMemoryIndex(input.store, { heldForgets: await input.outbox.heldKeys("forget") });
}
