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
 * The one recovery surface lives here too: `requeue` and `discard` act on every entry
 * nothing will deliver again, which is both `rejected` and `uncertain`. An `uncertain`
 * entry may already have committed on the provider, so requeueing it is the one decision
 * the operator has to make explicitly (`allowDuplicate`); discarding it is a loss they
 * have already accepted. Both are reachable from the CLI by the note, by the entry's
 * client id — the handle every "delivery unknown" answer prints — or for everything at once.
 *
 * Neither decision is taken from the listing these methods read: the outbox re-makes it against
 * the entry file under its own lock, because a sync may have changed that entry since. And a
 * discard takes the writes that waited on what it dropped (`refused`): their replacement is not
 * known to be on the provider, so releasing them would retire a source with nothing in its place.
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
import { rewindPullCursor } from "@nathapp/nax-agent/internal";
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
  /**
   * Whether the index rendered with `note` added would drop entries off the end — the
   * projection the host's own index is rendered from. Asked by feature 1's save for a slug
   * the mirror does not hold, so a new note cannot silently push a note a session reads out.
   */
  readonly indexOverflows: (note: MemoryNote) => Promise<boolean>;
  readonly operations: MemoryWriteOperations;
}

/**
 * Which undelivered outbox entries a requeue or a discard acts on.
 *
 * Three identities, because the operator has three: a note's scope and slug (the write they
 * remember), one entry's client id (the handle every "delivery unknown" answer prints), and
 * `"all"`. A client id is not a slug — the outbox mints UUIDs, which are a legal slug shape —
 * so the id is its own target rather than a guess made from the positional argument.
 */
export type MemoryRecoveryTarget =
  | { readonly scope: MemoryScope; readonly slug: string }
  | { readonly clientId: string }
  | "all";

/** What one recovery moved, and what it left for the operator to decide. */
export interface MemoryRecoveryResult {
  /** How many entries the operation moved. */
  readonly moved: number;
  /**
   * The client ids of the uncertain entries a requeue left in place, because the duplicate risk
   * was not acknowledged. Empty for a discard, which takes them.
   */
  readonly heldBack: readonly string[];
  /**
   * The client ids a discard refused because they waited on the write it dropped — absent when a
   * discard refused none.
   *
   * Removing a replacement leaves its source retirements naming an id nothing holds, which a sync
   * reads as a delivered replacement and sends. Its delivery was never proven, so they are refused
   * instead: their sources stay on the provider, and this names them for the operator.
   */
  readonly refused?: readonly string[];
}

/** What a requeue takes beyond the entries: the operator's acceptance of the duplicate risk. */
export interface MemoryRequeueOptions {
  /**
   * Requeue entries whose dispatch may already have committed. An uncertain entry is exactly
   * that, so the next sync would send it again and the server may hold two copies: only the
   * operator can decide that is what they want.
   */
  readonly allowDuplicate?: boolean;
}

/** The write surface a host exposes: one method per host write. */
export interface HostWrites {
  save(write: MemoryNoteWrite): Promise<MemorySaveResult>;
  forget(input: {
    readonly scope: MemoryScope;
    readonly slug: string;
    readonly reason: string;
  }): Promise<MemoryForgetResult>;
  approve(input: { readonly scope: MemoryScope; readonly slug: string }): Promise<MemoryNote>;
  /**
   * Put the undelivered entries `target` names back in the queue — `rejected` ones, and the
   * `uncertain` ones `options.allowDuplicate` accepts.
   */
  requeue(target: MemoryRecoveryTarget, options?: MemoryRequeueOptions): Promise<MemoryRecoveryResult>;
  /** Drop the undelivered entries `target` names from the outbox: `rejected` and `uncertain`. */
  discard(target: MemoryRecoveryTarget): Promise<MemoryRecoveryResult>;
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

/** One save: feature 1's operation, given the host's write mode, source and index projection. */
async function save(input: HostWritesInput, write: MemoryNoteWrite): Promise<MemorySaveResult> {
  return await input.operations.saveMemoryNote({
    store: input.store,
    outbox: input.outbox,
    provider: input.provider,
    logger: input.logger,
    write,
    writeMode: input.writeMode,
    source: input.source,
    indexOverflows: input.indexOverflows,
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
    requeue: (target, options) => requeue(input.outbox, target, options),
    discard: (target) => discard(input, target),
  };
}

/**
 * Whether an entry is one `target` names, and one nothing will deliver again.
 *
 * Both undelivered states are the operator's: `rejected` was refused, and `uncertain` was
 * dispatched without an answer by a provider that may not repeat it. A `queued` write is still
 * on its way, so neither operation touches it.
 */
function undeliveredMatches(entry: MemoryOutboxEntry, target: MemoryRecoveryTarget): boolean {
  if (entry.state === "queued") return false;
  if (target === "all") return true;
  if ("clientId" in target) return entry.clientId === target.clientId;
  return entry.scope === target.scope && entry.slug === target.slug;
}

/**
 * Put undelivered entries back in the queue, oldest first, so the next sync pushes them again.
 *
 * A parked entry (one a provider kept answering badly) and a refused one are both `rejected`;
 * requeueing either restores the write as it was taken, and the next sync decides it afresh.
 * An `uncertain` entry is the different case this option exists for: its dispatch may already
 * have committed, so requeueing it makes a second copy unless the operator says the risk is
 * theirs — it is left in place, and named in `heldBack`, until they do.
 *
 * The listing this starts from is a snapshot, so the decision is not taken from it: the outbox
 * re-reads each entry under its own lock and answers what it did. A `rejected` entry a sync has
 * since dispatched and left unanswered is `held` — not requeued on the strength of how it looked
 * a moment ago — and one another recovery already put back is `unchanged`, not moved.
 */
async function requeue(
  outbox: MemoryOutbox,
  target: MemoryRecoveryTarget,
  options: MemoryRequeueOptions = {},
): Promise<MemoryRecoveryResult> {
  const matches = (await outbox.list()).filter((entry) => undeliveredMatches(entry, target));
  const allowDuplicate = options.allowDuplicate === true;
  const heldBack: string[] = [];
  let moved = 0;
  for (const entry of matches) {
    const outcome = await outbox.requeue(entry.clientId, { allowDuplicate });
    if (outcome === "requeued") moved += 1;
    else if (outcome === "held") heldBack.push(entry.clientId);
  }
  return { moved, heldBack };
}

/**
 * Drop undelivered entries for good — `rejected` and `uncertain` alike. A queued write is still
 * on its way and is never dropped here.
 *
 * The entry file is claimed and re-read before it is removed (`discardUndelivered`), so a
 * `requeue` that landed between the listing and this call survives: a write nobody has delivered
 * is never thrown away on the strength of a stale listing. Each scope a discard actually moved
 * has its pull rewound: a discarded forget leaves its note active on the provider, and an
 * incremental pull would never send that note again, so the next sync reads the scope in full and
 * the mirror takes the provider's copy.
 *
 * A discard also takes the writes that waited on what it dropped (`refused`). Their replacement
 * is not known to be on the provider, so releasing them would retire a source with nothing in its
 * place; they are refused instead, and their scopes' pulls are rewound for the same reason as a
 * discarded forget's — the provider's copy of the source is the mirror's only remaining one.
 *
 * A refused dependent is not itself discarded here: it is `rejected` now, so a later `discard`
 * drops it as any other undelivered write, and the two decisions stay the operator's.
 */
async function discard(input: HostWritesInput, target: MemoryRecoveryTarget): Promise<MemoryRecoveryResult> {
  const matches = (await input.outbox.list()).filter((entry) => undeliveredMatches(entry, target));
  const removed: MemoryOutboxEntry[] = [];
  const refused: MemoryOutboxEntry[] = [];
  for (const entry of matches) {
    const outcome = await input.outbox.discardUndelivered(entry.clientId);
    if (outcome.discarded) removed.push(entry);
    refused.push(...outcome.refused);
  }
  for (const scope of new Set([...removed, ...refused].map((entry) => entry.scope)))
    await rewindPullCursor(input.store, scope);
  return {
    moved: removed.length,
    heldBack: [],
    ...(refused.length === 0 ? {} : { refused: refused.map((entry) => entry.clientId) }),
  };
}
