/**
 * The memory host's write surface: save, forget and approve.
 *
 * Three methods, and the one rule that is this host's own rather than feature 1's:
 * a project note that only the repository holds is the repository's to edit, so a
 * forget or an approve of it is refused as `MEMORY_NOTE_READ_ONLY` and points at
 * the file to change. Nothing here writes a repo note — reading is the only
 * operation the repository's notes support, and this module only reads them to
 * answer that one question. A save of such a slug is *not* refused: the mirror may
 * hold a note with the same slug, and the mirror's note shadows the team's.
 *
 * Everything else is feature 1's, passed through with the host's own two stamps:
 * the `writeMode` the config resolved and the `source` this host was opened with.
 * So a validation refusal stays `MEMORY_WRITE_REFUSED` with the validator's reason,
 * an absent slug stays `MEMORY_NOTE_NOT_FOUND`, and a queued write stays a result
 * rather than an error — this module adds no error translation of its own.
 *
 * The operations are handed in rather than imported, because the host that
 * composes them owns the `_memoryHostDeps` seam a test replaces; passing the
 * object through keeps a stub installed after the host was opened visible here.
 */
import type {
  MemoryApproveInput,
  MemoryForgetInput,
  MemoryForgetResult,
  MemoryNote,
  MemoryNoteWrite,
  MemoryOutbox,
  MemoryOutboxEntry,
  MemoryProvider,
  MemorySaveInput,
  MemorySaveResult,
  MemoryScope,
  MemoryStore,
} from "@nathapp/nax-agent";
import { PROJECT_NAX_DIR } from "@/config";
import { NaxError } from "@/errors";
import type { MemoryLogger } from "./paths";

/** Stage every refusal this module writes carries. */
const LOG_STAGE = "memory";
/** Where a repository note lives, relative to the repository root — named in the refusal. */
const REPO_NOTE_DIR_LABEL = `${PROJECT_NAX_DIR}/memory`;

/** The three feature-1 operations a host's writes are composed from. */
export interface MemoryWriteOperations {
  saveMemoryNote(input: MemorySaveInput): Promise<MemorySaveResult>;
  forgetMemoryNote(input: MemoryForgetInput): Promise<MemoryForgetResult>;
  approveMemoryNote(input: MemoryApproveInput): Promise<MemoryNote>;
}

/** What one host's write surface is composed from. */
export interface HostWritesInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly provider: MemoryProvider;
  readonly logger: MemoryLogger;
  /** The label a note this host writes records as its origin. */
  readonly source: string;
  /** `direct` takes effect at once; `proposal` holds a write pending until it is approved. */
  readonly writeMode: "direct" | "proposal";
  /** The repository's committed project notes, re-read for every refusal. */
  readonly repoNotes: () => Promise<readonly MemoryNote[]>;
  readonly operations: MemoryWriteOperations;
}

/** Which rejected outbox entries a requeue or a discard acts on: one note's, or every one. */
export type MemoryRejectedTarget = { readonly scope: MemoryScope; readonly slug: string } | "all";

/** The write surface a host exposes: one method per host write. */
export interface HostWrites {
  save(write: MemoryNoteWrite): Promise<MemorySaveResult>;
  forget(input: {
    readonly scope: MemoryScope;
    readonly slug: string;
    readonly reason: string;
  }): Promise<MemoryForgetResult>;
  approve(input: { readonly scope: MemoryScope; readonly slug: string }): Promise<MemoryNote>;
  /** Put the rejected entries `target` names back in the queue; answers how many were requeued. */
  requeue(target: MemoryRejectedTarget): Promise<number>;
  /** Drop the rejected entries `target` names from the outbox; answers how many were dropped. */
  discard(target: MemoryRejectedTarget): Promise<number>;
}

/** The refusal for a slug only the repository holds: the note is the repository's to edit. */
function repoNoteRefusal(slug: string): NaxError {
  return new NaxError(
    `memory note "${slug}" is a repository note; edit ${REPO_NOTE_DIR_LABEL}/${slug}.md in the repository`,
    "MEMORY_NOTE_READ_ONLY",
    { stage: LOG_STAGE, slug },
  );
}

/**
 * Refuse a mutation of a project note only the repository holds.
 *
 * The mirror is asked first, because the mirror's note is the agent's own and
 * shadows the team's note of that slug — a slug both hold is a note this host may
 * retire. Only when the mirror holds nothing does the repository's set decide, and
 * a slug neither holds falls through: the operation that follows answers it with
 * its own `MEMORY_NOTE_NOT_FOUND`, which is a different fact from "the team owns it".
 *
 * The user scope is never refused. A repo note is always project-scoped, so there
 * is nothing in the user mirror this rule could protect.
 */
async function refuseRepoOnly(input: HostWritesInput, scope: MemoryScope, slug: string): Promise<void> {
  if (scope !== "project") return;
  if ((await input.store.readNote(scope, slug)) !== null) return;
  const held = (await input.repoNotes()).some((note) => note.slug === slug);
  if (!held) return;
  throw repoNoteRefusal(slug);
}

/** One save: feature 1's operation, given the host's write mode and source. */
async function save(input: HostWritesInput, write: MemoryNoteWrite): Promise<MemorySaveResult> {
  return await input.operations.saveMemoryNote({
    store: input.store,
    outbox: input.outbox,
    provider: input.provider,
    logger: input.logger,
    write,
    writeMode: input.writeMode,
    source: input.source,
  });
}

/** One forget: refused when the repository owns the note, feature 1's operation otherwise. */
async function forget(
  input: HostWritesInput,
  request: { readonly scope: MemoryScope; readonly slug: string; readonly reason: string },
): Promise<MemoryForgetResult> {
  await refuseRepoOnly(input, request.scope, request.slug);
  return await input.operations.forgetMemoryNote({
    store: input.store,
    outbox: input.outbox,
    provider: input.provider,
    logger: input.logger,
    scope: request.scope,
    slug: request.slug,
    reason: request.reason,
    writeMode: input.writeMode,
  });
}

/** One approval: refused when the repository owns the note, feature 1's operation otherwise. */
async function approve(
  input: HostWritesInput,
  request: { readonly scope: MemoryScope; readonly slug: string },
): Promise<MemoryNote> {
  await refuseRepoOnly(input, request.scope, request.slug);
  return await input.operations.approveMemoryNote({
    store: input.store,
    scope: request.scope,
    slug: request.slug,
    logger: input.logger,
  });
}

/**
 * Build the write surface of one host.
 *
 * @param input.store - The mirror the writes land in
 * @param input.writeMode - The mode every save and forget is issued in
 * @param input.source - The label a saved note records as its origin
 * @param input.repoNotes - The repository's project notes, for the read-only refusals
 * @param input.operations - Feature 1's save, forget and approve
 */
export function createHostWrites(input: HostWritesInput): HostWrites {
  return {
    save: (write) => save(input, write),
    forget: (request) => forget(input, request),
    approve: (request) => approve(input, request),
    requeue: (target) => requeue(input.outbox, target),
    discard: (target) => discard(input.outbox, target),
  };
}

/** Whether a rejected entry is one `target` names. */
function rejectedMatches(entry: MemoryOutboxEntry, target: MemoryRejectedTarget): boolean {
  if (entry.state !== "rejected") return false;
  return target === "all" || (entry.scope === target.scope && entry.slug === target.slug);
}

/**
 * Put rejected entries back in the queue, oldest first, so the next sync pushes them again.
 *
 * A parked entry (one a provider kept answering badly) and a refused one are both `rejected`;
 * requeueing either restores the write as it was taken, and the next sync decides it afresh.
 */
async function requeue(outbox: MemoryOutbox, target: MemoryRejectedTarget): Promise<number> {
  const matches = (await outbox.list()).filter((entry) => rejectedMatches(entry, target));
  let requeued = 0;
  for (const entry of matches) {
    if (await outbox.requeue(entry.clientId)) requeued += 1;
  }
  return requeued;
}

/**
 * Drop rejected entries for good. Only `rejected` ones: a queued write is still on its way and
 * is never dropped here. A discarded forget leaves its note active on the provider, so the next
 * pull brings it back into the mirror; a discarded save leaves the mirror's copy as it is.
 */
async function discard(outbox: MemoryOutbox, target: MemoryRejectedTarget): Promise<number> {
  const matches = (await outbox.list()).filter((entry) => rejectedMatches(entry, target));
  for (const entry of matches) await outbox.remove(entry.clientId);
  return matches.length;
}
