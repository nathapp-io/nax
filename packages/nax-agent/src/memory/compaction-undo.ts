/**
 * Undoing one compaction: the notes it archived go back, the notes it wrote go away.
 *
 * An undo is the apply read backwards, and it is the same three records the other way round:
 * the archive holds the notes to put back, the manifest holds the notes the apply created, and
 * the log line is the record that the compaction happened at all. Which of them is the source
 * of truth is the one thing the caller decides. With no id the log picks the newest compaction
 * still marked `undone: false`; with an explicit id the manifest is authoritative, which is what
 * makes the two crash windows recoverable at all — an `applying` manifest (the process died
 * during steps 4-7) and an `applied` one with no log line (it died between steps 7 and 8).
 *
 * Everything it writes is what a direct save and a direct forget stage — the note in the mirror
 * plus its request on the outbox — under the same ordering and the same lock file an apply
 * takes. So the sync that already delivers those requests is what tells a provider about the
 * undo, and the undo never talks to one itself. The index is refreshed from the mirror once the
 * mirror is final, the manifest is rewritten to say the compaction no longer stands, and the log
 * line — when there is one to mark — is marked in place.
 *
 * A restored note is a re-save, not a resurrection: it keeps the original's slug, type,
 * description, body and source, and takes a fresh id and the caller's clock. A provider assigns
 * its own id to the save it is handed, and the note that comes back is a new write either way,
 * so an id that claims to be the old one would be the only thing that lied.
 *
 * Two things it will not do quietly. It will not overwrite a note somebody changed since the
 * compaction: the archive holds the notes as they were and the manifest holds when the apply
 * wrote what it wrote, so a mirror that disagrees with either has moved on, and the undo refuses
 * with the slugs it would have lost — `force` is the caller saying it knows. And it will not
 * guess at a target: no open log line, an id the archive could not have minted, a line already
 * undone, a pruned archive, a manifest that is not one or one that already says the compaction is
 * finished (unless the log still holds the open line an interrupted undo left) are all
 * `MEMORY_COMPACT_NOT_FOUND`, with nothing read outside the archive and nothing written. A sync
 * of this process in flight refuses with `MEMORY_BUSY` before anything is read at all; every
 * other writer is a lock this waits for like any other.
 *
 * Nothing here is transactional on purpose. Every step is a whole-note write or delete, and the
 * one wait it does not leave behind — the removal of a merged note — is queued as a forget before
 * the note goes, so an undo that dies part-way leaves a mirror and an outbox a re-run converges
 * on rather than either caught between two states. `force` is for the mirror half of that
 * convergence: a note that changed since is the caller's to accept. It is never permission to
 * undo a compaction that has already been undone.
 */
import { randomUUID } from "node:crypto";
import type { AgentLogger } from "#src/infra/agent-logger";
import { NaxError } from "#src/infra/nax-error";
import {
  contentIdentity,
  type MemoryCompactionLogLine,
  type MemoryCompactionManifest,
  type MemoryCompactionManifestStatus,
  markCompactionLogUndone,
  readCompactionArchiveNotes,
  readCompactionLogLines,
  readCompactionManifest,
  withCompactionRetentionLock,
  writeCompactionManifest,
} from "./compaction-archive.ts";
import { MEMORY_COMPACTION_ID_RE, type MemoryUndoResult } from "./compaction-types.ts";
import { clockOf, mirrorBusy, mirrorSyncInFlight, orderedByMirrorLocks, withMirrorLock } from "./mirror-lock.ts";
import { refreshIndex } from "./operations-support.ts";
import type { MemoryOutbox } from "./outbox.ts";
import type { MemoryStore } from "./store.ts";
import type { MemoryNote, MemoryTimers } from "./types.ts";

const ERROR_STAGE = "memory";

/**
 * One compaction to undo: the mirror and queue to undo it in, the id to undo (the newest the
 * log holds when absent), and the lock wait's seams.
 *
 * `force` belongs to the changed-note check a later story adds; the seam is here so a caller
 * passes the same input whether or not a note has changed since.
 */
export interface MemoryUndoInput {
  readonly store: MemoryStore;
  readonly outbox: MemoryOutbox;
  readonly logger: AgentLogger;
  readonly id?: string;
  readonly force?: boolean;
  readonly now?: () => Date;
  readonly timers?: MemoryTimers;
  readonly isAlive?: (pid: number) => boolean;
}

/** One compaction an undo acts on: the id it is addressed by, and the manifest that describes it. */
interface UndoTarget {
  readonly id: string;
  readonly manifest: MemoryCompactionManifest;
}

/**
 * The refusal an undo has no compaction to act on answers with.
 *
 * It is deliberately one code for every reason the target cannot be established — no line, no
 * archive, a file that is not a manifest — because the caller's next move is the same in all of
 * them, and naming the reason in the message is what tells a person which one it was.
 */
function targetNotFound(input: MemoryUndoInput, id?: string): NaxError {
  return new NaxError(
    id === undefined
      ? "memory undo: this mirror holds no compaction left to undo"
      : `memory undo: compaction "${id}" is not in this mirror`,
    "MEMORY_COMPACT_NOT_FOUND",
    {
      stage: ERROR_STAGE,
      projectDir: input.store.paths.projectDir,
      ...(id === undefined ? {} : { id }),
    },
  );
}

/** The newest line the log holds that is not yet undone: the default target. */
async function newestOpenLine(store: MemoryStore): Promise<MemoryCompactionLogLine | null> {
  const lines = await readCompactionLogLines(store);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && !line.undone) return line;
  }
  return null;
}

/** What the compaction log says about one id. */
type LogState = "absent" | "open" | "undone";

/**
 * The log's answer about one compaction: an open line, a line already marked undone, or no line
 * at all.
 *
 * A malformed line is not this module's business — `readCompactionLogLines` drops those — and an
 * id the log holds twice answers `undone` if either line says so, because the refusal it protects
 * is the irreversible one.
 */
async function logState(store: MemoryStore, id: string): Promise<LogState> {
  const lines = await readCompactionLogLines(store);
  let open = false;
  for (const line of lines) {
    if (line.id !== id) continue;
    if (line.undone) return "undone";
    open = true;
  }
  return open ? "open" : "absent";
}

/**
 * The compaction this undo acts on, with its manifest read from the archive.
 *
 * An explicit id is answered from its manifest and the log together, which is what makes the two
 * crash windows recoverable: the log line is a record of a *finished* apply, and the states an
 * undo most needs to reach are exactly the ones no line describes. Without an id the log picks
 * the newest compaction still open, and the archive it names is then read the same way — so the
 * two paths cannot disagree about what an archive has to contain. The log says *which*
 * compaction, never *what* it did.
 */
async function resolveTarget(input: MemoryUndoInput): Promise<UndoTarget> {
  if (input.id === undefined) {
    const newest = await newestOpenLine(input.store);
    if (newest === null) throw targetNotFound(input);
    return await manifestTarget(input, newest.id, "open");
  }
  return await namedTarget(input, input.id);
}

/**
 * One id the caller spelled as a target, or the refusal that says it is not one.
 *
 * The id is checked against `MEMORY_COMPACTION_ID_RE` *before* any archive path is spelled from
 * it: the id becomes a directory name, and a caller that typed `../outside` would otherwise have
 * this module read a manifest, and restore notes, outside the archive it was asked about. A name
 * the archive mints is the only name the archive answers for, and a log line is only ever read
 * for an id that passed that check.
 *
 * A log line already marked `undone` is the refusal: that compaction was reversed, and repeating
 * the undo would write the originals back over a mirror a later compaction may already have
 * changed. The line — not the manifest's own `status` — is what says so, because the log is
 * marked last: an undo that died between rewriting the manifest and marking the line leaves a
 * manifest that says `undone` and a line that is still open, and refusing that one would leave
 * the open line blocking every later undo. Re-running it converges instead. An id with no line at
 * all is answered by the manifest, which is the whole of what the two crash windows have.
 */
async function namedTarget(input: MemoryUndoInput, id: string): Promise<UndoTarget> {
  if (!MEMORY_COMPACTION_ID_RE.test(id)) throw targetNotFound(input, id);
  const state = await logState(input.store, id);
  if (state === "undone") throw targetNotFound(input, id);
  return await manifestTarget(input, id, state);
}

/** Whether a manifest's status says the compaction is finished, one way or the other. */
function isFinished(status: MemoryCompactionManifestStatus): boolean {
  return status === "undone" || status === "rolled_back";
}

/**
 * One id as a target, refusing when the archive holds no manifest this module can act on.
 *
 * The manifest also has to *be* this archive's: the id the caller asked for is what every step
 * keys on — the `notes/` directory it restores from, the log line it marks, the manifest path
 * it rewrites — so a manifest whose own `id` names a different compaction is a directory that
 * is not the one asked for, however well-formed the file is. Acting on it would read one
 * compaction's notes, delete another's merge targets and write the status to a third path.
 *
 * A manifest that already says the compaction is finished — `undone`, or `rolled_back` — is only
 * actionable while the log still holds an *open* line for it, which is the one unfinished step of
 * an undo that died between rewriting the manifest and marking the log. Anything else is a
 * compaction this undo has already completed or reversed, and repeating it would write the
 * archived originals back over whatever has happened since: `nax memory undo <id> --force` on a
 * log-less compaction an earlier run had already undone overwrote a note edited after it, instead
 * of answering `MEMORY_COMPACT_NOT_FOUND` (review B4). `force` is the caller accepting that a
 * note changed, never a licence to undo twice, so this check runs before it is consulted.
 */
async function manifestTarget(input: MemoryUndoInput, id: string, state: LogState): Promise<UndoTarget> {
  const manifest = await readCompactionManifest({ store: input.store, id });
  if (manifest === null || manifest.id !== id) throw targetNotFound(input, id);
  if (isFinished(manifest.status) && state !== "open") throw targetNotFound(input, id);
  return { id, manifest };
}

/**
 * The status an undo leaves the manifest in.
 *
 * A compaction that finished is `undone`: its writes stood, and this is the record that they no
 * longer do. One that never finished is `rolled_back` instead — the same word a failed apply
 * leaves — because nothing about it was ever true for longer than the crash, and an archive that
 * says `undone` would claim a completed compaction that a person then reversed.
 */
function statusAfterUndo(status: MemoryCompactionManifestStatus): MemoryCompactionManifestStatus {
  return status === "applying" ? "rolled_back" : "undone";
}

/**
 * The refusal an undo that would overwrite a note changed since the compaction answers with.
 *
 * The slugs are in the message *and* in the context: the message is what a person reads to
 * decide whether to run the undo again with `force`, and the list is what a caller reports
 * without parsing prose out of it.
 */
function changedSince(input: MemoryUndoInput, target: UndoTarget, slugs: readonly string[]): NaxError {
  return new NaxError(
    `memory undo: compaction "${target.id}" changed these notes since it ran: ${slugs.join(", ")}`,
    "MEMORY_COMPACT_CHANGED",
    { stage: ERROR_STAGE, projectDir: input.store.paths.projectDir, id: target.id, slugs },
  );
}

/**
 * The slugs the undo would overwrite, in the two ways a note can have moved on since.
 *
 * A note the compaction created is changed when its `updatedAt` is not the one the manifest
 * recorded — the manifest is the only thing that knows when the apply wrote it, so a note
 * somebody saved afterwards is exactly the note that no longer says what it did.
 *
 * A note the compaction *archived* is changed when the mirror holds one under that slug
 * again, unless this compaction wrote that slug: an archived original was taken out of the
 * mirror, so anything under its slug now was written after, and putting the original back
 * over it would delete somebody's note. A slug the manifest did write is a created note and
 * is checked as one, which is what makes a merge that keeps its own source slug undoable.
 *
 * A created note the mirror no longer holds is not a change: there is nothing left for the
 * undo to overwrite, and the removal step answers with no removal rather than inventing one.
 *
 * Each affected slug is read on its own with `readNote`, never through `listNotes`. The listing
 * reports a note it cannot read once and skips it, which here would read as "the mirror does not
 * hold this slug" — and an archived slug somebody recreated and then made unreadable would be
 * overwritten by the restore instead of stopping the undo (review B5). Whether a note the check
 * cannot read is changed is not a question this check may answer on the caller's behalf, so the
 * read error propagates and nothing is written. Only the slugs the compaction touched are asked
 * for, each exactly once, whether it created the slug, archived it or both — the check reads what
 * it judges, not the whole mirror (review M1).
 */
async function changedSlugs(
  input: MemoryUndoInput,
  target: UndoTarget,
  originals: readonly MemoryNote[],
): Promise<readonly string[]> {
  const created = target.manifest.created ?? [];
  const createdSlugs = new Set(created.map((note) => note.slug));
  const watched = new Set<string>(createdSlugs);
  for (const original of originals) watched.add(original.slug);
  const held = new Map<string, MemoryNote | null>();
  for (const slug of watched) held.set(slug, await input.store.readNote("project", slug));
  const changed: string[] = [];
  for (const written of created) {
    const note = held.get(written.slug) ?? null;
    if (
      note !== null &&
      (written.contentHash ? contentIdentity(note) !== written.contentHash : note.updatedAt !== written.updatedAt)
    )
      changed.push(written.slug);
  }
  for (const original of originals) {
    if (createdSlugs.has(original.slug)) continue;
    if ((held.get(original.slug) ?? null) !== null) changed.push(original.slug);
  }
  return changed;
}

/** Refuse when the mirror has moved on since the compaction, naming every note that moved. */
async function refuseIfChanged(
  input: MemoryUndoInput,
  target: UndoTarget,
  originals: readonly MemoryNote[],
): Promise<void> {
  const changed = await changedSlugs(input, target, originals);
  if (changed.length > 0) throw changedSince(input, target, changed);
}

/**
 * Whether this undo has to check that the mirror still holds what the compaction left.
 *
 * `force` is the caller saying it has read the changed notes and wants the undo anyway. An
 * `applying` manifest is exempt for a different reason: that compaction never finished, so the
 * notes it wrote are the ones the crash happened to leave, and a mirror holding one of the
 * archived originals is a half-done undo rather than somebody's edit. There is nothing to
 * compare a note against, and the undo is a recovery, not a reversal.
 */
function checksForChanges(input: MemoryUndoInput, target: UndoTarget): boolean {
  return input.force !== true && target.manifest.status !== "applying";
}

/**
 * One archived note as the mirror is given it back: the original's content, a fresh id and the
 * caller's clock — a re-save, which is what the provider is told it is.
 */
function restoredNote(original: MemoryNote, updatedAt: string): MemoryNote {
  return { ...original, id: randomUUID(), status: "active", updatedAt };
}

/**
 * Put one archived note back, then declare its save, exactly as a direct save would.
 *
 * The note's own id is the request's client id, so the note, the request and the write a later
 * sync delivers are named by one id — the same binding a save makes, and the same one an apply
 * makes for the notes it writes.
 */
async function restoreNote(input: MemoryUndoInput, original: MemoryNote): Promise<void> {
  const note = restoredNote(original, clockOf(input)().toISOString());
  await input.store.writeNote(note);
  await input.outbox.enqueue({
    kind: "save",
    clientId: note.id,
    scope: note.scope,
    slug: note.slug,
    writeMode: "direct",
    note,
  });
}

/** The reason one undo's removal carries: what tells its own request from any other forget. */
function undoReason(id: string): string {
  return `undo compaction ${id}`;
}

/**
 * The slugs the outbox already holds *this* compaction's undo removal for.
 *
 * A request is this undo's own when it is the pair the entry itself records: the compaction id in
 * the reason, and the slug it names. A forget for the slug alone is not equivalent, and treating
 * one as equivalent is what let an earlier run lose the removal (review B2, second pass). A
 * forget queued before the compaction ran sits *ahead* of the apply's save in the delivery order,
 * so a removal that counted it queued nothing, delivery then replayed the save after it, and the
 * merged note came back on the provider — even though the mirror no longer held it. A request that
 * names this compaction can only have been taken by an undo of it, and it is always behind that
 * save, so a re-run recognizes it and queues nothing twice.
 */
async function heldUndoRemovals(input: MemoryUndoInput, target: UndoTarget): Promise<Set<string>> {
  const reason = undoReason(target.id);
  const held = new Set<string>();
  for (const entry of await input.outbox.list()) {
    if (entry.state !== "queued" || entry.kind !== "forget") continue;
    if (entry.scope === "project" && entry.reason === reason) held.add(entry.slug);
  }
  return held;
}

/**
 * Take the merge targets the compaction created out of the mirror, unless one is an archived
 * original — a merge that kept one of its own source slugs wrote *that* note, and the note the
 * archive holds is the one it has to answer with.
 *
 * The forget is queued *before* the note is deleted, and only when this undo's own request for
 * that note is not already in the outbox, which is what makes a re-run converge (review B2). The
 * two orders are not interchangeable: an undo that deletes first and then fails to queue the
 * forget — a full outbox, a write error — leaves a mirror with no note and a provider that still
 * holds it, and the re-run finds nothing to delete, skips the step, and never queues the forget
 * either. The merge the apply wrote comes back on the provider's next pull, or the still-queued
 * save for it resurrects it there. Queuing first makes the intent durable: a queued forget with
 * the note still present is delivered by the next sync, and a re-run after a failure between the
 * two steps sees the entry and queues nothing twice. Nothing can deliver it in between — the whole
 * undo runs under the mirror lock every writer and every sync of this mirror takes.
 *
 * A target the mirror does not hold is not a removal, but it is still bookkeeping: the request is
 * queued if it is not already there, and the slug is not reported as removed by this run.
 */
async function removeMergedNotes(
  input: MemoryUndoInput,
  target: UndoTarget,
  restoredSlugs: ReadonlySet<string>,
): Promise<readonly string[]> {
  const removed: string[] = [];
  const queued = await heldUndoRemovals(input, target);
  for (const merge of target.manifest.merged) {
    if (restoredSlugs.has(merge.into)) continue;
    if (!queued.has(merge.into)) {
      await input.outbox.enqueue({
        kind: "forget",
        clientId: randomUUID(),
        scope: "project",
        slug: merge.into,
        writeMode: "direct",
        reason: undoReason(target.id),
      });
      queued.add(merge.into);
    }
    if ((await input.store.readNote("project", merge.into)) === null) continue;
    await input.store.deleteNote("project", merge.into);
    removed.push(merge.into);
  }
  return removed;
}

/**
 * The locked half of an undo: restore, remove, refresh the index, and record what it did.
 *
 * The order is the apply's, reversed, and it matters for the same reason: the originals go back
 * before anything is deleted, so a merge target that is also an archived slug is answered by the
 * restored note rather than by the note the apply wrote there, and the index is rendered from a
 * mirror that is already final.
 */
async function undoLocked(input: MemoryUndoInput, target: UndoTarget): Promise<MemoryUndoResult> {
  const originals = await readCompactionArchiveNotes({
    store: input.store,
    id: target.id,
    expected: new Set([...target.manifest.retired, ...target.manifest.merged.flatMap((m) => m.from)]),
  });
  if (checksForChanges(input, target)) await refuseIfChanged(input, target, originals);
  const restored: string[] = [];
  for (const original of originals) {
    await restoreNote(input, original);
    restored.push(original.slug);
  }
  const removed = await removeMergedNotes(input, target, new Set(restored));
  await refreshIndex({ store: input.store, outbox: input.outbox });
  await writeCompactionManifest({
    store: input.store,
    manifest: { ...target.manifest, status: statusAfterUndo(target.manifest.status) },
  });
  await markCompactionLogUndone({ store: input.store, id: target.id });
  return { id: target.id, restored, removed };
}

/**
 * Undo one compaction of this mirror, and answer what it restored and removed.
 *
 * A sync of this process owns the mirror is the one refusal checked before everything else:
 * `MEMORY_BUSY`, nothing written, and the caller retries — waiting it out would be waiting for
 * a drain the caller cannot bound. Every other writer, in this process or another, is a lock
 * this undo waits for like any other.
 *
 * The target is resolved under the compaction lifecycle lock — the lock an apply holds for its
 * whole run — so the log line an undo picks cannot be appended to by another process between
 * choosing it and acting on it, and the archive it reads cannot be pruned away. The mirror
 * itself is changed as this store's only writer, under the same ordering and lock a save takes.
 */
export async function undoMemoryCompaction(input: MemoryUndoInput): Promise<MemoryUndoResult> {
  if (mirrorSyncInFlight(input.store)) throw mirrorBusy(input.store);
  return await orderedByMirrorLocks(input.store, () =>
    withCompactionRetentionLock(input, async () => {
      const target = await resolveTarget(input);
      return await withMirrorLock(input, () => undoLocked(input, target));
    }),
  );
}
