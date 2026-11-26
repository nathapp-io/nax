/**
 * host-compact.ts — the compaction surface of a memory host: its candidates, its apply and
 * its undo.
 *
 * Three optional members on `MemoryHost`, composed here rather than in `host.ts`, which is at
 * its size cap. The composition is the one `host-writes.ts` gets: the mirror, the queue, the
 * config and the repository this host already reads, plus the two feature-1 operations passed
 * in through `_memoryHostDeps` so a stub installed after the host was opened is the one the
 * next call reaches. Nothing here imports `host.ts`, so no initialisation cycle can form.
 *
 * What this file adds to those operations is the three facts only a host knows:
 *
 * - `reservedSlugs`, the repository's slugs, which the mirror does not hold but a merge target
 *   may not take either;
 * - `keepArchives`, how many applied archives this project keeps, read from the config this
 *   host resolved;
 * - and one sync after each call. A compaction writes the mirror and the queue, exactly as a
 *   direct save and forget do, so delivery is the existing sync's job rather than this
 *   module's: the apply never talks to a provider. A sync that throws is reported and nothing
 *   else — the compaction is already staged, its result stands, and the next sync delivers it.
 *
 * Both members refuse under `memory.writeMode: "proposal"` before any operation is reached: a
 * proposal-mode compaction (every retire and merge held for approval) is not built, and a
 * silent no-op would leave a person believing the mirror had changed.
 */
import type { MemoryNote, MemoryOutbox, MemoryStore, MemorySyncResult } from "@nathapp/nax-agent";
import {
  type applyMemoryCompaction,
  errorMessage,
  type MemoryCompactionPlan,
  type MemoryCompactionResult,
  type MemoryUndoResult,
  memoryCompactionCandidates,
  type undoMemoryCompaction,
} from "@nathapp/nax-agent/internal";
import type { MemoryConfig } from "@/config";
import { NaxError } from "@/errors";
import type { MemoryLogger } from "./paths";

/** Stage every refusal and warn this module writes carries. */
const LOG_STAGE = "memory";

/** The message both refusals carry: what a surface prints after `Error: `. */
const UNSUPPORTED_MESSAGE = 'memory compaction is not available with memory.writeMode "proposal"; nothing was changed';

/** One compaction to apply on this host: the plan a person confirmed, the model, and the fill before it. */
export interface MemoryApplyCompactionInput {
  readonly expectedCandidates?: readonly MemoryNote[];
  readonly plan: MemoryCompactionPlan;
  readonly model: string;
  readonly fillBefore: number;
}

/** One compaction to undo: the id (the newest untouched one when absent) and whether later edits may be lost. */
export interface MemoryUndoCompactionInput {
  readonly id?: string;
  readonly force?: boolean;
}

/** The compaction surface a host exposes. */
export interface HostCompaction {
  /** The notes a plan may act on, in slug order. */
  repositorySlugs(): Promise<ReadonlySet<string>>;
  compactionCandidates(): Promise<readonly MemoryNote[]>;
  applyCompaction(input: MemoryApplyCompactionInput): Promise<MemoryCompactionResult>;
  undoCompaction(input: MemoryUndoCompactionInput): Promise<MemoryUndoResult>;
}

/** The two feature-1 operations a host's compaction is composed from. */
export interface HostCompactionOperations {
  applyMemoryCompaction: typeof applyMemoryCompaction;
  undoMemoryCompaction: typeof undoMemoryCompaction;
}

/** What one host's compaction surface is composed from. */
export interface HostCompactionInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly logger: MemoryLogger;
  /** The resolved memory config: `compact.keepArchives` and the write mode both come from it. */
  readonly config: MemoryConfig;
  readonly providerId: string;
  readonly writeMode: "direct" | "proposal";
  /** The repository's committed project notes, re-read for the slugs a merge target may not take. */
  readonly repoNotes: () => Promise<readonly MemoryNote[]>;
  /** The host's own sync: what delivers the writes a compaction or an undo staged. */
  readonly sync: () => Promise<MemorySyncResult>;
  readonly operations: HostCompactionOperations;
}

/** The refusal a proposal-mode host answers both members with, before anything is read or written. */
function unsupported(): NaxError {
  return new NaxError(UNSUPPORTED_MESSAGE, "MEMORY_COMPACT_UNSUPPORTED", { stage: LOG_STAGE, writeMode: "proposal" });
}

/** The slugs the repository holds: a merge target may not take one the mirror cannot see. */
async function reservedSlugs(input: HostCompactionInput): Promise<ReadonlySet<string>> {
  return new Set((await input.repoNotes()).map((note) => note.slug));
}

/**
 * Run the one sync that delivers what the call staged.
 *
 * The compaction is already in the mirror and the outbox by the time this runs, so a sync that
 * throws is a delivery problem, not a failed compaction: it is logged once and the caller's
 * result stands, because refusing here would report a write that did happen as one that did not.
 */
async function syncAfter(input: HostCompactionInput, message: string): Promise<void> {
  try {
    await input.sync();
  } catch (error) {
    input.logger.warn(LOG_STAGE, message, { error: errorMessage(error) });
  }
}

/** One apply: the operation with the facts only this host knows, then one sync. */
async function apply(input: HostCompactionInput, request: MemoryApplyCompactionInput): Promise<MemoryCompactionResult> {
  if (input.writeMode === "proposal") throw unsupported();
  const result = await input.operations.applyMemoryCompaction({
    store: input.store,
    outbox: input.outbox,
    logger: input.logger,
    plan: request.plan,
    expectedCandidates: request.expectedCandidates,
    reservedSlugs: await reservedSlugs(input),
    keepArchives: input.config.compact.keepArchives,
    provider: input.providerId,
    model: request.model,
    fillBefore: request.fillBefore,
  });
  await syncAfter(input, "compaction applied, but its sync failed");
  return result;
}

/** One undo: the operation, then one sync of the writes it staged back. */
async function undo(input: HostCompactionInput, request: MemoryUndoCompactionInput): Promise<MemoryUndoResult> {
  if (input.writeMode === "proposal") throw unsupported();
  const result = await input.operations.undoMemoryCompaction({
    store: input.store,
    outbox: input.outbox,
    logger: input.logger,
    id: request.id,
    force: request.force,
  });
  await syncAfter(input, "compaction undone, but its sync failed");
  return result;
}

/**
 * Build the compaction surface of one host.
 *
 * @param input.store - The mirror every call reads and writes
 * @param input.outbox - The queue the staged writes land in
 * @param input.config - The resolved memory config (`compact.keepArchives`)
 * @param input.providerId - The provider the apply records in its manifest
 * @param input.repoNotes - The repository's project notes, for the slugs a merge may not take
 * @param input.sync - The host's sync, run once after each successful call
 * @param input.operations - Feature 1's apply and undo
 */
export function createHostCompaction(input: HostCompactionInput): HostCompaction {
  return {
    repositorySlugs: () => reservedSlugs(input),
    compactionCandidates: () => memoryCompactionCandidates({ store: input.store, outbox: input.outbox }),
    applyCompaction: (request) => apply(input, request),
    undoCompaction: (request) => undo(input, request),
  };
}
