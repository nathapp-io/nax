/**
 * Applying one confirmed compaction to a mirror — the only path that changes a mirror on
 * behalf of a plan.
 *
 * A plan is confirmed by a person and applied by this module, and the two facts that shape
 * everything here are that the model call ran *without* the lock and that the mirror is a
 * store other writers change. So the plan is re-validated against the mirror as it is now,
 * under the same ordering and the same lock file a save takes (`orderedByMirrorLocks` then
 * `withMirrorLock`), and the notes it is about to overwrite are archived before the first
 * change. An apply that finds the mirror owned by a sync of this process refuses with
 * `MEMORY_BUSY` and writes nothing: the caller retries rather than competing with a drain.
 *
 * The writes an apply stages are exactly what a direct save and a direct forget stage — a note
 * in the mirror plus its request on the outbox — so the provider is told about the compaction
 * by the sync that already delivers them, and an apply never talks to a provider itself. The
 * index is refreshed from the mirror afterwards, so the next session reads what the apply left
 * rather than what was there before.
 *
 * The archive (see `compaction-archive.ts`) is the order the writes are safe in. Step by step:
 * revalidate; archive the notes the plan touches and record an `applying` manifest; stage the
 * merges and the retires; refresh the index; rewrite the manifest `applied`; append the log
 * line. A failure after the archive restores the notes and removes only this apply's queued
 * requests, failed log bytes and new merge targets. The archive remains recoverable with a
 * `rolled_back` manifest. Successful applies prune old applied archives outside the lock.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLogger } from "#src/infra/agent-logger";
import { NaxError } from "#src/infra/nax-error";
import {
  appendCompactionLog,
  contentIdentity,
  type MemoryCompactionLogLine,
  type MemoryCompactionManifest,
  type MemoryCompactionManifestMerge,
  type MemoryCompactionManifestNote,
  pruneCompactionArchives,
  readCompactionLog,
  withCompactionRetentionLock,
  writeCompactionArchive,
  writeCompactionManifest,
} from "./compaction-archive.ts";
import { memoryCompactionCandidates, validateMemoryCompactionPlan } from "./compaction-plan.ts";
import { type CompactionStaging, compactionFailed, rollbackCompaction } from "./compaction-rollback.ts";
import {
  MEMORY_COMPACTION_SOURCE,
  type MemoryCompactionMerge,
  type MemoryCompactionPlan,
  type MemoryCompactionResult,
} from "./compaction-types.ts";
import { clockOf, mirrorBusy, mirrorSyncInFlight, orderedByMirrorLocks, withMirrorLock } from "./mirror-lock.ts";
import { serializeMemoryNote } from "./note.ts";
import { refreshIndex } from "./operations-support.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryNote, MemoryTimers } from "./types.ts";

const ERROR_STAGE = "memory";

/**
 * One compaction to apply: the plan, the mirror and queue it acts on, and the facts the
 * manifest records.
 *
 * `reservedSlugs` is what a merge target may not take beyond the mirror's own slugs (the nax
 * host passes the repository notes' slugs, which the mirror does not hold), and `keepArchives`
 * is how many applied archives the mirror keeps. `now` and `newId` are the clock and the id
 * source, so a test can pin both; `timers` and `isAlive` are the lock wait's seams.
 */
export interface MemoryCompactionApplyInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly logger: AgentLogger;
  readonly plan: MemoryCompactionPlan;
  readonly expectedCandidates?: readonly MemoryNote[];
  /** Slugs a merge target may not take beyond the mirror's own (the nax host passes repository note slugs). */
  readonly reservedSlugs?: ReadonlySet<string>;
  readonly keepArchives: number;
  readonly provider: string;
  readonly model: string;
  readonly fillBefore: number;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly timers?: MemoryTimers;
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * The refusal a plan the mirror no longer matches answers with, naming every reason.
 *
 * The reasons are the validator's own, joined into the message *and* carried in the context:
 * the message is what a person reads, and the list is what the caller revises the plan from.
 */
function planInvalid(reasons: readonly string[]): NaxError {
  return new NaxError(`memory compaction plan is invalid: ${reasons.join("; ")}`, "MEMORY_COMPACT_PLAN_INVALID", {
    stage: ERROR_STAGE,
    reasons,
  });
}

/** The slugs a merge target may not take: every project note the mirror holds, plus the reserved ones. */
function existingSlugsOf(projectNotes: readonly MemoryNote[], reserved: ReadonlySet<string>): Set<string> {
  const slugs = new Set(reserved);
  for (const note of projectNotes) slugs.add(note.slug);
  return slugs;
}

/**
 * The plan re-validated against the mirror as the apply finds it.
 *
 * This is step 2's whole job, and it is deliberately the same validator the preview ran: the
 * model call happened without the lock, so a note may have been retired, refiled or renamed
 * since, and a plan that named it must be re-proposed rather than applied to a mirror it no
 * longer describes.
 */
async function validatedMirror(input: MemoryCompactionApplyInput): Promise<MirrorView> {
  const [candidates, projectNotes] = await Promise.all([
    memoryCompactionCandidates({ store: input.store, outbox: input.outbox }),
    input.store.listNotes("project"),
  ]);
  const check = validateMemoryCompactionPlan(
    input.plan,
    candidates,
    existingSlugsOf(projectNotes, input.reservedSlugs ?? new Set<string>()),
  );
  if (!check.ok) throw planInvalid(check.reasons);
  const mirror = new Map(candidates.map((n) => [n.slug, n]));
  const expected = input.expectedCandidates && new Map(input.expectedCandidates.map((n) => [n.slug, n]));
  for (const slug of archivedSlugs(input.plan)) {
    const physical = await input.store.readNote("project", slug);
    const candidate = mirror.get(slug);
    const original = expected ? expected.get(slug) : candidate;
    if (
      !physical ||
      physical.slug !== slug ||
      physical.scope !== "project" ||
      !candidate ||
      !original ||
      serializeMemoryNote(physical) !== serializeMemoryNote(candidate) ||
      serializeMemoryNote(physical) !== serializeMemoryNote(original)
    )
      throw planInvalid([`source ${slug} changed since planning`]);
  }
  for (const merge of input.plan.merge) {
    if (!merge.from.includes(merge.into.slug) && (await targetExists(input.store, merge.into.slug)))
      throw planInvalid([`merge target ${merge.into.slug} is occupied`]);
  }
  return { candidates, projectNotes };
}

/** A vacant key has no directory entry, not merely no decodable note. */
async function targetExists(store: MemoryStore, slug: string): Promise<boolean> {
  try {
    await lstat(join(store.paths.notesDir, `${slug}.md`));
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

/** The locked half of an apply: revalidate, archive, stage, and record what it did. */
async function applyLocked(input: MemoryCompactionApplyInput): Promise<MemoryCompactionResult> {
  const view = await validatedMirror(input);
  let applying: Applying;
  try {
    applying = await archiveBefore(input, view);
  } catch (cause) {
    throw compactionFailed(cause);
  }
  const staging: CompactionStaging = { writtenSlugs: new Set(), enqueuedIds: new Set() };
  try {
    return await stageAndRecord({ ...input, staging }, applying);
  } catch (cause) {
    const complete = await rollbackCompaction({
      ...input,
      staging,
      originals: applying.originals,
      manifest: applyingManifest(input, applying),
    });
    throw compactionFailed(cause, { id: applying.id, ...(complete ? {} : { rollback: "incomplete" }) });
  }
}

/** One apply as its later steps know it: the id it was minted, when, and the note count it found. */
interface Applying {
  readonly id: string;
  readonly createdAt: string;
  readonly notesBefore: number;
  readonly originals: readonly MemoryNote[];
}

/** The mirror as the apply found it under the lock: what a plan may act on, and every note it holds. */
interface MirrorView {
  readonly candidates: readonly MemoryNote[];
  readonly projectNotes: readonly MemoryNote[];
}

/** Step 3: keep every note the plan touches, then record that the apply has begun. */
async function archiveBefore(input: MemoryCompactionApplyInput, view: MirrorView): Promise<Applying> {
  const createdAt = clockOf(input)();
  const touched = archivedSlugs(input.plan);
  let applying: Applying = {
    id: input.newId?.() ?? mintCompactionId(createdAt),
    createdAt: createdAt.toISOString(),
    notesBefore: view.projectNotes.length,
    originals: view.candidates.filter((note) => touched.has(note.slug)),
  };
  for (;;) {
    try {
      await writeCompactionArchive({ store: input.store, id: applying.id, notes: applying.originals });
      break;
    } catch (error) {
      if (input.newId || !(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      applying = { ...applying, id: mintCompactionId(createdAt) };
    }
  }
  await writeCompactionManifest({ store: input.store, manifest: applyingManifest(input, applying) });
  return applying;
}

/**
 * The manifest an apply begins with: what it intends, and nothing it cannot vouch for.
 *
 * `created` and `notesAfter` are absent on purpose — they are answers only a finished apply
 * has — so an apply that dies half-way leaves a manifest nobody can mistake for a success.
 */
function applyingManifest(input: MemoryCompactionApplyInput, applying: Applying): MemoryCompactionManifest {
  return {
    id: applying.id,
    createdAt: applying.createdAt,
    status: "applying",
    provider: input.provider,
    model: input.model,
    retired: input.plan.retire.map((retire) => retire.slug),
    merged: mergeRecordsOf(input.plan),
    notesBefore: applying.notesBefore,
    fillBefore: input.fillBefore,
  };
}

/** The plan's merges as the archive records them: the sources that went, and the slug that replaced them. */
function mergeRecordsOf(plan: MemoryCompactionPlan): readonly MemoryCompactionManifestMerge[] {
  return plan.merge.map((merge) => ({ from: merge.from, into: merge.into.slug }));
}

/** A compaction id from `at`: a UTC timestamp plus six hex characters, so ids sort by creation time. */
function mintCompactionId(at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

/**
 * Steps 4-8: stage every write, rebuild the index, and record what the compaction did.
 *
 * The staged writes are what a direct save and a direct forget stage — the note in the mirror
 * and its request on the outbox — so the provider hears about the compaction from the sync
 * that already delivers them. The index is refreshed before the manifest is completed, so the
 * manifest's `applied` status never describes a mirror whose index still lists a retired note.
 */
type StagingInput = MemoryCompactionApplyInput & { readonly staging: CompactionStaging };

async function stageAndRecord(input: StagingInput, applying: Applying): Promise<MemoryCompactionResult> {
  const created: MemoryCompactionManifestNote[] = [];
  for (const merge of input.plan.merge) created.push(await stageMerge(input, merge));
  for (const retire of input.plan.retire) await retireSlug(input, retire.slug, retire.reason);
  for (const merge of input.plan.merge) await retireMergeSources(input, merge);
  await refreshIndex({ store: input.store, outbox: input.outbox });
  const notesAfter = (await input.store.listNotes("project")).length;
  await writeCompactionManifest({
    store: input.store,
    manifest: appliedManifest(input, applying, { created, notesAfter }),
  });
  input.staging.logBefore = await readCompactionLog(input.store);
  await appendCompactionLog({
    store: input.store,
    before: input.staging.logBefore,
    line: logLineOf(input, applying, notesAfter),
  });
  return resultOf(input.plan, applying, notesAfter);
}

/** The manifest an apply finishes with: what it created, and how the mirror's note count moved. */
function appliedManifest(
  input: MemoryCompactionApplyInput,
  applying: Applying,
  outcome: { readonly created: readonly MemoryCompactionManifestNote[]; readonly notesAfter: number },
): MemoryCompactionManifest {
  return {
    ...applyingManifest(input, applying),
    status: "applied",
    created: outcome.created,
    notesAfter: outcome.notesAfter,
  };
}

/** The log line an apply appends: the plan's action counts, never note bodies. */
function logLineOf(input: MemoryCompactionApplyInput, applying: Applying, notesAfter: number): MemoryCompactionLogLine {
  return {
    id: applying.id,
    createdAt: applying.createdAt,
    retired: input.plan.retire.length,
    merged: input.plan.merge.length,
    notesBefore: applying.notesBefore,
    notesAfter,
    fillBefore: input.fillBefore,
    undone: false,
  };
}

/** What the caller is told the apply did: the archive's id and the plan's actions. */
function resultOf(plan: MemoryCompactionPlan, applying: Applying, notesAfter: number): MemoryCompactionResult {
  return {
    id: applying.id,
    retired: plan.retire.map((retire) => retire.slug),
    merged: mergeRecordsOf(plan),
    notesBefore: applying.notesBefore,
    notesAfter,
  };
}

/** The note a merge leaves in the mirror: a fresh id, the compaction's source and the caller's clock. */
function mergedNote(merge: MemoryCompactionMerge, updatedAt: string): MemoryNote {
  return {
    id: randomUUID(),
    slug: merge.into.slug,
    type: merge.into.type,
    scope: "project",
    description: merge.into.description,
    source: MEMORY_COMPACTION_SOURCE,
    updatedAt,
    status: "active",
    body: merge.into.body,
  };
}

/**
 * Step 4 for one merge: write the merged note and declare its save, as a direct save would.
 *
 * The note's own id is the request's client id, so the note, the request and the write a later
 * sync delivers are named by one id — the same binding a save makes.
 */
async function stageMerge(input: StagingInput, merge: MemoryCompactionMerge): Promise<MemoryCompactionManifestNote> {
  const note = mergedNote(merge, clockOf(input)().toISOString());
  input.staging.writtenSlugs.add(note.slug);
  await input.store.writeNote(note);
  input.staging.enqueuedIds.add(note.id);
  await input.outbox.enqueue({
    kind: "save",
    clientId: note.id,
    scope: "project",
    slug: note.slug,
    writeMode: "direct",
    note,
  });
  return { slug: note.slug, updatedAt: note.updatedAt, contentHash: contentIdentity(note) };
}

/**
 * Step 5 for one slug: delete the note and declare its forget, as a direct forget would.
 *
 * The note goes first because a forget of a slug the mirror still holds would be replayed
 * against a live note; the entry is what makes the retire durable, and it is written with the
 * reason the person confirmed.
 */
async function retireSlug(input: StagingInput, slug: string, reason: string): Promise<void> {
  await input.store.deleteNote("project", slug);
  const clientId = randomUUID();
  input.staging.enqueuedIds.add(clientId);
  await input.outbox.enqueue({
    kind: "forget",
    clientId,
    scope: "project",
    slug,
    writeMode: "direct",
    reason,
  });
}

/**
 * Step 5 for one merge: retire every source that is not the slug the merge wrote.
 *
 * A merge that keeps one of its own source slugs leaves that note in place — the merged note
 * *is* it — so it is the one source a merge does not forget.
 */
async function retireMergeSources(input: StagingInput, merge: MemoryCompactionMerge): Promise<void> {
  for (const from of merge.from) {
    if (from === merge.into.slug) continue;
    await retireSlug(input, from, `merged into ${merge.into.slug}`);
  }
}

/**
 * Every slug the plan touches: the notes it retires and the notes its merges fold.
 *
 * A merge that keeps one of its own source slugs is still archived under that slug — the note
 * that is there now is what the merge overwrites, so it is exactly what an undo needs back.
 */
function archivedSlugs(plan: MemoryCompactionPlan): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const retire of plan.retire) slugs.add(retire.slug);
  for (const merge of plan.merge) for (const from of merge.from) slugs.add(from);
  return slugs;
}

/**
 * Apply one confirmed compaction to this mirror, or refuse before writing anything.
 *
 * Refusals come first and in this order: a sync of this process owns the mirror
 * (`MEMORY_BUSY`), and a plan the mirror no longer matches (`MEMORY_COMPACT_PLAN_INVALID`).
 * Everything after them runs as the mirror's only writer — one apply at a time in this process
 * (`orderedByMirrorLocks`) and one writer at a time across processes (the store's lock files) —
 * because the mirror the plan is re-validated against has to be the mirror it changes.
 */
export async function applyMemoryCompaction(input: MemoryCompactionApplyInput): Promise<MemoryCompactionResult> {
  if (mirrorSyncInFlight(input.store)) throw mirrorBusy(input.store);
  return await orderedByMirrorLocks(input.store, () =>
    withCompactionRetentionLock(input, async () => {
      const result = await withMirrorLock(input, () => applyLocked(input));
      await pruneCompactionArchives({ ...input, id: result.id });
      return result;
    }),
  );
}
