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
 * is appended on success. A failed append is restored to its pre-append bytes while the
 * writer lock is still held, so even a partial failed record cannot become history.
 *
 * The manifest's shape is its own type rather than a re-use of `MemoryCompactionResult`: the
 * file outlives the run that wrote it and is read by a later process (`nax memory undo`), so
 * it changes only when the on-disk format does.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { realOrRaw } from "#src/internal/realpath";
import { byCodePoint } from "#src/internal/sort";
import { archiveDirectoryIdentities, archiveText, inArchive, invalidArchive, pinned } from "./compaction-directory.ts";
import { MEMORY_COMPACTION_ID_RE } from "./compaction-types.ts";
import { type MirrorLockInput, withMirrorLocks } from "./mirror-lock.ts";
import { parseMemoryNote, serializeMemoryNote } from "./note.ts";
import { _memoryStoreDeps, type MemoryStore } from "./store.ts";

import { MEMORY_SLUG_RE, type MemoryNote } from "./types.ts";

/** Filesystem seams for log recovery and archive pruning. */
interface ArchiveEntry {
  name: string;
  file: boolean;
  directory: boolean;
}
export const _compactionArchiveDeps = {
  appendFile,
  readFile,
  rm: async (path: string, options: { recursive?: boolean; force: true }) =>
    options.recursive ? pinned<void>(path, "removeTree") : rm(path, options),
  entries: (dir: string) => pinned<ArchiveEntry[]>(dir, "entries"),
};

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

/** Provider acknowledgement may replace the id and timestamp but not the saved content. */
export function contentIdentity(note: MemoryNote): string {
  return createHash("sha256")
    .update(serializeMemoryNote({ ...note, id: "", updatedAt: "" }))
    .digest("hex");
}

export interface MemoryCompactionManifestNote {
  readonly contentHash?: string;
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

/**
 * The shape a manifest file has to have to be read back as one.
 *
 * An undo acts on what the file says — which merge targets it created, whether it ever
 * finished — so a file that does not carry those fields cannot be acted on, and the answer is
 * "this archive is not a compaction" rather than a half-applied guess. `created` and
 * `notesAfter` stay optional because an `applying` manifest genuinely has neither.
 */
const ManifestSchema = z.object({
  id: z.string().regex(MEMORY_COMPACTION_ID_RE),
  createdAt: z.string().min(1),
  status: z.enum(["applying", "applied", "rolled_back", "undone"]),
  provider: z.string().min(1),
  model: z.string().min(1),
  retired: z.array(z.string().min(1)),
  merged: z.array(z.object({ from: z.array(z.string().min(1)).min(1), into: z.string().min(1) })),
  created: z
    .array(z.object({ slug: z.string().min(1), updatedAt: z.string().min(1), contentHash: z.string().optional() }))
    .optional(),
  notesBefore: z.number().int().nonnegative(),
  notesAfter: z.number().int().nonnegative().optional(),
  fillBefore: z.number(),
});

/**
 * The shape a `compactions.jsonl` line has to have to be read back as one.
 *
 * A line that fails it is skipped rather than repaired: the log is the default target an undo
 * resolves by, and a line whose fields the undo would go on to read must be one the undo can
 * trust. Its id has to name an archive, which is the same pattern the archive directory is
 * found by.
 */
const LogLineSchema = z.object({
  id: z.string().regex(MEMORY_COMPACTION_ID_RE),
  createdAt: z.string().min(1),
  retired: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  notesBefore: z.number().int().nonnegative(),
  notesAfter: z.number().int().nonnegative(),
  fillBefore: z.number(),
  undone: z.boolean(),
});

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
  await inArchive({ ...input, create: true, exclusive: true, notes: true }, async (notesDir) => {
    for (const note of input.notes) {
      if (!MEMORY_SLUG_RE.test(note.slug)) throw invalidArchive(input.id);
      await writeFileAtomic(join(notesDir, `${note.slug}.md`), serializeMemoryNote(note));
    }
  });
}

/** A path that is not there: an archive with no notes, rather than a failure to report. */
function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** The slug one archived file holds, or `null` when it is not a regular file named after a note. */
function archivedSlugIn(entry: ArchiveEntry): string | null {
  if (!entry.file) return null;
  const suffix = ".md";
  if (!entry.name.endsWith(suffix)) return null;
  const slug = entry.name.slice(0, -suffix.length);
  return MEMORY_SLUG_RE.test(slug) ? slug : null;
}

/**
 * Every note one compaction archived, in slug order — what an undo puts back.
 *
 * The files are the compaction's own record of the notes as they were, so they are decoded
 * with the same codec a mirror read uses: a file the note schema refuses is not restored as
 * something else. An archive with no `notes/` directory holds nothing to restore (an apply
 * always creates it, so this is a directory that was tampered with or is not an archive).
 */
export async function readCompactionArchiveNotes(input: {
  readonly store: MemoryStore;
  readonly id: string;
  readonly expected: ReadonlySet<string>;
}): Promise<readonly MemoryNote[]> {
  return inArchive({ ...input, notes: true }, async (notesDir) => {
    const entries = await _compactionArchiveDeps.entries(notesDir);
    const slugs = entries
      .map((entry) => archivedSlugIn(entry))
      .filter((slug): slug is string => slug !== null)
      .sort(byCodePoint);
    if (
      entries.length !== slugs.length ||
      slugs.length !== input.expected.size ||
      slugs.some((s) => !input.expected.has(s))
    )
      throw invalidArchive(input.id);
    const notes: MemoryNote[] = [];
    for (const slug of slugs) {
      const note = parseMemoryNote(await archiveText(join(notesDir, `${slug}.md`)));
      if (
        note.slug !== slug ||
        note.scope !== "project" ||
        note.status !== "active" ||
        (note.type !== "project" && note.type !== "reference")
      )
        throw invalidArchive(input.id);
      notes.push(note);
    }
    return notes;
  });
}

/** Publish one compaction's manifest, replacing whatever the previous step wrote there. */
export async function writeCompactionManifest(input: {
  readonly store: MemoryStore;
  readonly manifest: MemoryCompactionManifest;
}): Promise<void> {
  await inArchive({ store: input.store, id: input.manifest.id, create: true }, () =>
    writeFileAtomic(
      compactionManifestPath(input.store, input.manifest.id),
      `${JSON.stringify(input.manifest, null, 2)}\n`,
    ),
  );
}

/**
 * One compaction's manifest as it is on disk, or `null` when there is not one to act on.
 *
 * A missing file, a file that is not JSON and a file whose shape is not a manifest all answer
 * the same thing, because they mean the same thing to a caller: this id does not name a
 * compaction this mirror can undo. Reading is the only place that judgement is made, so a
 * caller never has to distinguish "absent" from "unreadable" itself.
 */
export async function readCompactionManifest(input: {
  readonly store: MemoryStore;
  readonly id: string;
}): Promise<MemoryCompactionManifest | null> {
  let text: string;
  try {
    text = await inArchive(input, (dir) => archiveText(join(dir, MANIFEST_FILE)));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const parsed = ManifestSchema.safeParse(decodeJson(text));
  return parsed.success ? parsed.data : null;
}

/** One decoded JSON value, or `null` when the text is not JSON. */
function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: the caller's schema check turns it into "this is not one of ours".
    return null;
  }
}

/** One log line as a compaction record, or `null` when the line is not one. */
function parseLogLine(line: string): MemoryCompactionLogLine | null {
  const parsed = LogLineSchema.safeParse(decodeJson(line));
  return parsed.success ? parsed.data : null;
}

/**
 * Append one line to the mirror's compaction log.
 *
 * The log is the history an undo reads to pick its default target. A successful append
 * preserves every earlier byte; a failed append is taken back by the apply's rollback. The
 * project directory is created first, because a mirror with no notes has no directory yet.
 */
export async function appendCompactionLog(input: {
  readonly store: MemoryStore;
  readonly line: MemoryCompactionLogLine;
  readonly before?: Uint8Array | null;
}): Promise<void> {
  await _memoryStoreDeps.mkdir(input.store.paths.projectDir, { recursive: true });
  const before = input.before === undefined ? await readCompactionLog(input.store) : input.before;
  const separator = before?.length && before.at(-1) !== 10 ? "\n" : "";
  await _compactionArchiveDeps.appendFile(
    input.store.paths.compactionsLog,
    `${separator}${JSON.stringify(input.line)}\n`,
    "utf8",
  );
}

/** Snapshot only immediately before append, under the writer lock. */
export async function readCompactionLog(store: MemoryStore): Promise<Uint8Array | null> {
  try {
    return await _compactionArchiveDeps.readFile(store.paths.compactionsLog);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Restore earlier lines byte-for-byte, removing a newly created log when there was none. */
export async function restoreCompactionLog(store: MemoryStore, before: Uint8Array | null): Promise<void> {
  if (before === null) await _compactionArchiveDeps.rm(store.paths.compactionsLog, { force: true });
  else await writeFileAtomic(store.paths.compactionsLog, before);
}

/** The log as lines, or none when the mirror has never compacted. */
async function compactionLogLines(store: MemoryStore): Promise<string[]> {
  const bytes = await readCompactionLog(store);
  if (bytes === null) return [];
  // A log written by an older nax is still a log: the decoder only has to survive its bytes.
  return new TextDecoder().decode(bytes).split("\n");
}

/**
 * Every line the log holds that is a compaction record, in the order it was appended.
 *
 * A line that is not one is skipped, not repaired and not reported: the log is append-only
 * history, and one truncated record — a crash between a write and its newline, a file edited by
 * hand — must not make every compaction before it unreachable. The caller gets the records it
 * can act on, and that is what an undo resolves its default target from.
 */
export async function readCompactionLogLines(store: MemoryStore): Promise<readonly MemoryCompactionLogLine[]> {
  const lines: MemoryCompactionLogLine[] = [];
  for (const line of await compactionLogLines(store)) {
    const parsed = parseLogLine(line);
    if (parsed !== null) lines.push(parsed);
  }
  return lines;
}

/**
 * Mark one compaction's line `undone: true`, leaving every other line byte for byte as it was.
 *
 * The log is append-only history, so the one entry an undo changes is re-encoded and the rest
 * are written back as the exact text that was read — a re-serialisation of a line nobody asked
 * to change would rewrite history the log exists to preserve. The whole file is published
 * atomically, so a crash during an undo leaves the old log or the new one. Answers whether a
 * line was there to mark: an `applied` manifest with no log line (an apply that died before its
 * last step) has nothing to mark, and that is not a failure.
 */
export async function markCompactionLogUndone(input: {
  readonly store: MemoryStore;
  readonly id: string;
}): Promise<boolean> {
  const lines = await compactionLogLines(input.store);
  if (lines.length === 0) return false;
  let marked = false;
  const next = lines.map((line) => {
    const parsed = parseLogLine(line);
    if (parsed === null || parsed.id !== input.id) return line;
    marked = true;
    return JSON.stringify({ ...parsed, undone: true });
  });
  if (!marked) return false;
  await writeFileAtomic(input.store.paths.compactionsLog, next.join("\n"));
  return true;
}

/** An unreadable or malformed manifest is not proof that its archive is safe to prune. */
async function isAppliedArchive(store: MemoryStore, id: string): Promise<boolean> {
  try {
    // A shape this module would not act on is an archive whose state cannot be established.
    const manifest = await readCompactionManifest({ store, id });
    return manifest?.id === id && manifest.status === "applied";
  } catch {
    // Retain archives whose state cannot be established, including a concurrent disappearance.
    return false;
  }
}

/** Warn without letting an optional retention pass change a successful apply's result. */
function warnRetention(logger: AgentLogger, path: string, error: unknown): void {
  try {
    logger.warn("memory", "memory compaction could not prune archive", { path, error: errorMessage(error) });
  } catch {
    // The compaction has succeeded; a broken logger cannot change that answer.
  }
}

/**
 * Serialize the entire apply/retention lifecycle across processes, not merely the pruning
 * passes: otherwise one pass can delete the next apply's archive before its pass starts.
 * Acquire before the mirror lock; release after pruning, which still runs without the mirror
 * lock. Call inside orderedByMirrorLocks so another caller of this process waits too.
 * Reuse the mirror protocol's wait, heartbeat and stale-holder recovery with the input seams.
 */
export function withCompactionRetentionLock<T>(input: MirrorLockInput, work: () => Promise<T>): Promise<T> {
  const dir = realOrRaw(input.store.paths.projectDir);
  return withMirrorLocks(input, [{ dir, path: join(dir, "compaction.lock") }], () =>
    archiveDirectoryIdentities.run(new Map(), work),
  );
}

/**
 * Outside the mirror lock (but inside the compaction lifecycle lock), retain only applied,
 * id-named directories. The current archive owns one slot even if the caller's clock sorts
 * it before another id (or the limit is zero).
 */
export async function pruneCompactionArchives(input: {
  readonly store: MemoryStore;
  readonly id: string;
  readonly keepArchives: number;
  readonly logger: AgentLogger;
}): Promise<void> {
  const { store, logger } = input;
  try {
    await inArchive({ store }, async (root) => {
      const applied: string[] = [];
      const entries = await _compactionArchiveDeps.entries(root);
      for (const entry of entries) {
        if (
          entry.directory &&
          MEMORY_COMPACTION_ID_RE.test(entry.name) &&
          (await isAppliedArchive(store, entry.name))
        ) {
          if (entry.name !== input.id) applied.push(entry.name);
        }
      }
      applied.sort((left, right) => byCodePoint(right, left));
      const otherSlots = Math.max(0, Math.floor(input.keepArchives) - 1);
      for (const id of applied.slice(otherSlots)) {
        const path = compactionArchiveDir(store, id);
        try {
          await _compactionArchiveDeps.rm(path, { recursive: true, force: true });
        } catch (error) {
          warnRetention(logger, path, error);
        }
      }
    });
  } catch (error) {
    warnRetention(logger, store.paths.archiveDir, error);
  }
}
