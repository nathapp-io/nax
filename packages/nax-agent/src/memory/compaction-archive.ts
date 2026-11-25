/**
 * The compaction archive: the files one compaction leaves behind, and the log of them all.
 *
 * An archive is what makes a confirmed compaction reversible, so it is written *before* the
 * mirror changes and it holds the notes as they were: one `<slug>.md` per note the plan
 * touches (`serializeMemoryNote` of the note the mirror held), beside a `manifest.json` that
 * says what the apply is doing, what it did and how the mirror's note count moved. The
 * archive lives beside `notes/` in the project mirror, and the store's listings only ever
 * read `notes/`, so an archive cannot leak into the index a session reads.
 *
 * Two layouts live here because they are one decision. The manifest is the per-compaction
 * record an apply rewrites as it progresses (`applying` → `applied`, or `rolled_back`) and an
 * undo reads back; `compactions.jsonl` is the mirror-wide, append-only history an undo picks
 * its default target from. Both are written here so the file names, the JSON and the
 * directory shape are spelled once.
 *
 * A note file is published atomically (`writeFileAtomic`), like every other file this package
 * publishes: a crash mid-archive leaves the previous file or none, never a torn one. The log
 * is appended rather than rewritten, because it is history — a line that was written stays.
 *
 * The manifest's shape is its own type rather than a re-use of `MemoryCompactionResult`: the
 * file outlives the run that wrote it and is read by a later process (`nax memory undo`), so
 * it changes only when the on-disk format does.
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { serializeMemoryNote } from "./note.ts";
import { _memoryStoreDeps, type MemoryStore } from "./store.ts";
import { NOTES_DIR } from "./store-paths.ts";
import type { MemoryNote } from "./types.ts";

/** The file each archive directory keeps its manifest in. */
export const MANIFEST_FILE = "manifest.json";

/**
 * Where a compaction stands: `applying` while it runs, `applied` once every write landed,
 * `rolled_back` after a failed apply was undone, and `undone` after an undo restored one.
 */
export type MemoryCompactionManifestStatus = "applying" | "applied" | "rolled_back" | "undone";

/** One merge as the archive records it: the notes that went, and the slug that replaced them. */
export interface MemoryCompactionManifestMerge {
  readonly from: readonly string[];
  readonly into: string;
}

/** One note a compaction wrote, with the `updatedAt` it was written with. */
export interface MemoryCompactionManifestNote {
  readonly slug: string;
  readonly updatedAt: string;
}

/**
 * What one compaction did, as `manifest.json` holds it.
 *
 * `created` and `notesAfter` are absent while the compaction is `applying` — they are the two
 * answers only the finished apply has — so an apply that died half-way leaves a manifest that
 * says what it intended and nothing it cannot vouch for.
 */
export interface MemoryCompactionManifest {
  readonly id: string;
  readonly createdAt: string;
  readonly status: MemoryCompactionManifestStatus;
  readonly provider: string;
  readonly model: string;
  readonly retired: readonly string[];
  readonly merged: readonly MemoryCompactionManifestMerge[];
  readonly created?: readonly MemoryCompactionManifestNote[];
  readonly notesBefore: number;
  readonly notesAfter?: number;
  readonly fillBefore: number;
}

/** One line of `compactions.jsonl`: what a compaction did, in counts, and whether it was undone. */
export interface MemoryCompactionLogLine {
  readonly id: string;
  readonly createdAt: string;
  readonly retired: number;
  readonly merged: number;
  readonly notesBefore: number;
  readonly notesAfter: number;
  readonly fillBefore: number;
  readonly undone: boolean;
}

/** The directory one compaction's archive lives in: `<archiveDir>/<id>`. */
export function compactionArchiveDir(store: MemoryStore, id: string): string {
  return join(store.paths.archiveDir, id);
}

/** The manifest path of one compaction's archive. */
export function compactionManifestPath(store: MemoryStore, id: string): string {
  return join(compactionArchiveDir(store, id), MANIFEST_FILE);
}

/**
 * Keep every note the plan touches, as the mirror holds it, before the apply changes any.
 *
 * The files sit in the archive's own `notes/` directory beside the manifest, one per slug, so
 * an undo can put a note back without knowing what the plan was. The directory is created
 * first — for a compaction that archives nothing (a merge into one of its own source slugs,
 * say) the manifest still has an archive directory to be written into.
 */
export async function writeCompactionArchive(input: {
  readonly store: MemoryStore;
  readonly id: string;
  readonly notes: readonly MemoryNote[];
}): Promise<void> {
  const notesDir = join(compactionArchiveDir(input.store, input.id), NOTES_DIR);
  await _memoryStoreDeps.mkdir(notesDir, { recursive: true });
  for (const note of input.notes) {
    await writeFileAtomic(join(notesDir, `${note.slug}.md`), serializeMemoryNote(note));
  }
}

/** Publish one compaction's manifest, replacing whatever the previous step wrote there. */
export async function writeCompactionManifest(input: {
  readonly store: MemoryStore;
  readonly manifest: MemoryCompactionManifest;
}): Promise<void> {
  await _memoryStoreDeps.mkdir(compactionArchiveDir(input.store, input.manifest.id), { recursive: true });
  await writeFileAtomic(
    compactionManifestPath(input.store, input.manifest.id),
    `${JSON.stringify(input.manifest, null, 2)}\n`,
  );
}

/**
 * Append one line to the mirror's compaction log.
 *
 * Appended, never rewritten: the log is the history an undo reads to pick its default target,
 * so an earlier line describes a compaction that happened and stays as it was written. The
 * project directory is created first, because a mirror with no notes has no directory yet.
 */
export async function appendCompactionLog(input: {
  readonly store: MemoryStore;
  readonly line: MemoryCompactionLogLine;
}): Promise<void> {
  await _memoryStoreDeps.mkdir(input.store.paths.projectDir, { recursive: true });
  await appendFile(input.store.paths.compactionsLog, `${JSON.stringify(input.line)}\n`, "utf8");
}
