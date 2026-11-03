/**
 * File-backed note mirror. Slugs are validated before I/O; directory and existing
 * note targets must resolve inside their scope root.
 *
 * Reads and mutations are both run relative to a *pinned* parent. The parent's
 * identity is verified against the directory the store resolved, the helper process
 * then chdirs into it, and every later operation is resolved by that process against
 * its own cwd. A name on disk can be renamed or replaced afterwards without moving
 * the pinned directory, so nothing the store verified can be redirected underneath it:
 * a read takes the entry's bytes from the pinned parent, and a write stages, publishes
 * and cleans up there. Revalidating a pathname instead would leave the window this
 * closes — a parent swapped out of the root, restored for the check, and swapped out
 * again for the syscall names an outside file on both sides of the comparison.
 *
 * The caller's global cwd is never changed. Post-checks report moved directories;
 * they are not the mechanism that prevents access to replacements.
 *
 * The store also owns the record files beside the notes: the `decisions.jsonl`
 * mirror (one JSON object per line), the `pending-forgets.jsonl` record of queued
 * forgets, `sync.json` (the sync state) and each scope's generated `MEMORY.md`.
 * They hold no user-authored paths, so they are read and written without a slug to
 * validate — save a pending forget's own slug, which names a note and must be one.
 * The only scope rule is that the user files need a user directory. A record read is
 * still confined: it is read under the project directory's pin and never follows a
 * link out of the store.
 */
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { openPinnedRead, pinnedOperation, resolvePinned, withPinnedDirectory } from "#src/internal/pinned-directory";
import { isInside, realOrRaw } from "#src/internal/realpath";
import { byCodePoint } from "#src/internal/sort";
import { parseMemoryNote, serializeMemoryNote } from "./note.ts";
import {
  decodeRecordLines,
  defaultSyncState,
  encodeRecordLines,
  parseDecisionLine,
  parsePendingForgetLine,
  parseSyncStateText,
} from "./records.ts";
import {
  MEMORY_SLUG_RE,
  type MemoryDecision,
  type MemoryNote,
  type MemoryPendingForget,
  type MemoryScope,
} from "./types.ts";

const ERROR_STAGE = "memory";
const INDEX_FILE = "MEMORY.md";
const NOTES_DIR = "notes";
const NOTE_SUFFIX = ".md";
const DECISIONS_FILE = "decisions.jsonl";
const SYNC_STATE_FILE = "sync.json";
const PENDING_FORGETS_FILE = "pending-forgets.jsonl";

/** Reads refuse final-component links; the verified parent pin protects their ancestors. */
const READ_FLAGS: number = constants.O_RDONLY | constants.O_NOFOLLOW;

interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** One open file: read through its descriptor, never through its path. */
interface OpenedFile {
  readText(): Promise<string>;
  close(): Promise<void>;
}

/** Open one file for reading without following a link at it. */
type OpenFile = (path: string, flags: number) => Promise<OpenedFile>;
type StatPath = (path: string) => Promise<Identity>;
type MakeDir = (path: string, options: { recursive: true }) => Promise<string | undefined>;
/** Directory entries carry their type, so a listing never has to open a path to learn what it is. */
type ReadDirEntries = (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
type RemoveFile = (path: string, options: { force: true }) => Promise<void>;

function identityOf(info: { dev: number; ino: number }): Identity {
  return { dev: info.dev, ino: info.ino };
}

/** I/O seam: reads run under the pinned parent; deletes use the active one; `pin` takes it. */
export const _memoryStoreDeps: {
  open: OpenFile;
  stat: StatPath;
  mkdir: MakeDir;
  readdir: ReadDirEntries;
  rm: RemoveFile;
  pin: typeof withPinnedDirectory;
} = {
  open: async (path, flags) => {
    const pinned = await openPinnedRead(path, flags);
    if (pinned !== null) return pinned;
    const handle = await open(path, flags);
    return {
      stat: async () => identityOf(await handle.stat()),
      readText: () => handle.readFile({ encoding: "utf8" }),
      close: () => handle.close(),
    };
  },
  stat: async (path) => identityOf(await stat(path)),
  mkdir: (path, options) => mkdir(path, options),
  readdir: (path, options) => readdir(path, options),
  rm: (path, options) => pinnedOperation<void>(path, "rm") ?? rm(path, options),
  pin: withPinnedDirectory,
};

/** The files this store owns, spelled out once so every caller agrees on them. */
export interface MemoryStorePaths {
  readonly projectDir: string;
  readonly userDir: string | null;
  readonly index: string;
  readonly notesDir: string;
  readonly decisions: string;
  readonly pendingForgets: string;
  readonly syncState: string;
  readonly lock: string;
  readonly outboxDir: string;
  readonly userIndex: string | null;
  readonly userNotesDir: string | null;
}

/** Where the sync loop has got to: the provider it talks to and the two cursors. */
export interface MemorySyncState {
  readonly provider: string | null;
  readonly cursor: { readonly project: string | null; readonly user: string | null };
  readonly lastPullAt: string | null;
  readonly lastError: string | null;
}

/** The mirror: notes, plus the record files sync and the index refresh maintain. */
export interface MemoryStore {
  readonly paths: MemoryStorePaths;
  readNote(scope: MemoryScope, slug: string): Promise<MemoryNote | null>;
  writeNote(note: MemoryNote): Promise<void>;
  deleteNote(scope: MemoryScope, slug: string): Promise<void>;
  listNotes(scope: MemoryScope): Promise<MemoryNote[]>;
  readDecisions(): Promise<MemoryDecision[]>;
  writeDecisions(decisions: readonly MemoryDecision[]): Promise<void>;
  readPendingForgets(): Promise<MemoryPendingForget[]>;
  writePendingForgets(entries: readonly MemoryPendingForget[]): Promise<void>;
  readSyncState(): Promise<MemorySyncState>;
  writeSyncState(state: MemorySyncState): Promise<void>;
  writeIndex(scope: MemoryScope, text: string): Promise<void>;
}

/** `undefined`, `null` and `""` all mean "this store has no user directory". */
function dirOrNull(dir: string | null | undefined): string | null {
  return dir === undefined || dir === null || dir === "" ? null : dir;
}

function memoryStorePaths(projectDir: string, userDir: string | null): MemoryStorePaths {
  return {
    projectDir,
    userDir,
    index: join(projectDir, INDEX_FILE),
    notesDir: join(projectDir, NOTES_DIR),
    decisions: join(projectDir, DECISIONS_FILE),
    pendingForgets: join(projectDir, PENDING_FORGETS_FILE),
    syncState: join(projectDir, SYNC_STATE_FILE),
    lock: join(projectDir, "sync.lock"),
    outboxDir: join(projectDir, "outbox"),
    userIndex: userDir === null ? null : join(userDir, INDEX_FILE),
    userNotesDir: userDir === null ? null : join(userDir, NOTES_DIR),
  };
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** Only regular files and confined links with valid `<slug>.md` names are notes. */
function noteSlugIn(entry: Dirent): string | null {
  if (!entry.isFile() && !entry.isSymbolicLink()) return null;
  const name = entry.name;
  if (!name.endsWith(NOTE_SUFFIX)) return null;
  const slug = name.slice(0, -NOTE_SUFFIX.length);
  return MEMORY_SLUG_RE.test(slug) ? slug : null;
}

function invalidSlug(slug: string): NaxError {
  return new NaxError(`memory slug "${slug}" is not a valid note slug`, "MEMORY_SLUG_INVALID", {
    stage: ERROR_STAGE,
    slug,
  });
}

function scopeUnavailable(scope: MemoryScope): NaxError {
  return new NaxError(
    `memory scope "${scope}" is unavailable: this store has no user directory`,
    "MEMORY_SCOPE_UNAVAILABLE",
    {
      stage: ERROR_STAGE,
      scope,
    },
  );
}

function outsideRoot(scope: MemoryScope, path: string, root: string, cause?: unknown): NaxError {
  return new NaxError(`memory path "${path}" is outside the memory scope root "${root}"`, "MEMORY_PATH_OUTSIDE", {
    stage: ERROR_STAGE,
    scope,
    path,
    root,
    ...(cause === undefined ? {} : { cause }),
  });
}

function isOutsidePath(error: unknown): boolean {
  return error instanceof NaxError && error.code === "MEMORY_PATH_OUTSIDE";
}

function isSymlinkLoop(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ELOOP";
}

interface ScopedNotesDir {
  readonly root: string;
  readonly notesDir: string;
}

/** A notes directory the store has resolved, confined and identified. */
interface VerifiedDir {
  readonly scope: MemoryScope;
  readonly root: string;
  /** The directory as the caller spelled it: what a diagnostic names. */
  readonly spelling: string;
  /** The resolved directory: what a syscall uses, with no symlink left in it. */
  readonly dir: string;
  readonly identity: Identity;
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** The slug, validated: the one check that must happen before anything touches the filesystem. */
function validSlug(slug: string): void {
  if (!MEMORY_SLUG_RE.test(slug)) throw invalidSlug(slug);
}

export function createMemoryStore(input: {
  readonly projectDir: string;
  readonly userDir?: string | null;
  readonly logger: AgentLogger;
}): MemoryStore {
  const { logger } = input;
  const paths = memoryStorePaths(input.projectDir, dirOrNull(input.userDir));
  /** The notes directory of one scope, proved to sit inside that scope's root. */
  function confinedNotesDir(scope: MemoryScope): ScopedNotesDir {
    const root = scope === "user" ? paths.userDir : paths.projectDir;
    const notesDir = scope === "user" ? paths.userNotesDir : paths.notesDir;
    if (root === null || notesDir === null) throw scopeUnavailable(scope);
    if (!isInside(root, notesDir)) throw outsideRoot(scope, notesDir, root);
    return { root, notesDir };
  }
  /** The resolved form of `path`, refused unless it is still inside the root. */
  function confinedRealPath(scope: MemoryScope, root: string, path: string): string {
    const resolved = realOrRaw(path);
    if (!isInside(root, resolved)) throw outsideRoot(scope, path, root);
    return resolved;
  }
  /** The identity of whatever is at `path`, or `null` when nothing is. */
  async function identityAt(path: string): Promise<Identity | null> {
    try {
      return await _memoryStoreDeps.stat(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  /** The note's entry in a verified directory — the one place a note path is spelled. */
  function entryPathIn(handle: VerifiedDir, slug: string): string {
    return join(handle.dir, `${slug}${NOTE_SUFFIX}`);
  }
  /** The same entry as the caller spelled the directory: what a warning names. */
  function entryName(handle: VerifiedDir, slug: string): string {
    return join(handle.spelling, `${slug}${NOTE_SUFFIX}`);
  }
  /** The scope's notes directory, resolved, confined and identified. */
  async function openNotesDir(scope: MemoryScope): Promise<VerifiedDir | null> {
    const { root, notesDir } = confinedNotesDir(scope);
    const dir = confinedRealPath(scope, root, notesDir);
    const identity = await identityAt(dir);
    return identity === null ? null : { scope, root, spelling: notesDir, dir, identity };
  }
  /** The same, creating the directory (and its parents) first: the write path's entry point. */
  async function ensureNotesDir(scope: MemoryScope): Promise<VerifiedDir> {
    const { root, notesDir } = confinedNotesDir(scope);
    await _memoryStoreDeps.mkdir(notesDir, { recursive: true });
    const dir = confinedRealPath(scope, root, notesDir);
    // A directory that vanishes between the `mkdir` and this `stat` is a genuine failure,
    // not a missing mirror: the error propagates rather than being reported as "empty".
    const identity = await _memoryStoreDeps.stat(dir);
    return { scope, root, spelling: notesDir, dir, identity };
  }
  /** Detect movement of the original path; the pin is what keeps operations off a replacement. */
  async function assertSameDirectory(handle: VerifiedDir): Promise<void> {
    const dir = confinedRealPath(handle.scope, handle.root, handle.dir);
    const identity = await identityAt(dir);
    if (dir !== handle.dir || identity === null || !sameIdentity(identity, handle.identity)) {
      throw outsideRoot(handle.scope, handle.dir, handle.root);
    }
  }
  /**
   * One entry's text, read relative to the verified, pinned parent — never to a pathname.
   *
   * The worker resolves the entry against the cwd it pinned and verified, so a directory
   * renamed or replaced afterwards cannot redirect the answer. A plain file is then opened by
   * name inside that same session: no path in this process is revalidated, so the window a
   * check leaves — a parent swapped out of the root, restored for the check and swapped out
   * again for the syscall — does not exist here. A link is a name whose bytes live elsewhere,
   * so its target is confined against the scope root and read where it resolves.
   */
  async function readEntryText(handle: VerifiedDir, entry: string): Promise<string | null> {
    try {
      const resolved = await resolvePinned(entry);
      // Only reachable inside the pinned session; a vanished entry reads as missing.
      if (resolved === null) return null;
      if (resolved !== entry) return await readConfinedTarget(handle, resolved);
      const file = await openPinnedRead(entry, READ_FLAGS);
      if (file === null) return null;
      try {
        return await file.readText();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (isMissing(error)) return null;
      if (isSymlinkLoop(error)) throw outsideRoot(handle.scope, entry, handle.root, error);
      throw error;
    }
  }
  /** A link's destination has its own ancestors: the notes-directory pin cannot protect them. */
  async function readConfinedTarget(handle: VerifiedDir, target: string): Promise<string | null> {
    const resolved = confinedRealPath(handle.scope, handle.root, target);
    const dir = dirname(resolved);
    const identity = await identityAt(dir);
    if (identity === null) return null;
    return inPinnedDirectory({ ...handle, dir, spelling: dir, identity }, async () => {
      // Stat and spawn may have encountered a replaced ancestor. Prove confinement from
      // the destination pin itself, not by reopening its absolute spelling. Once proved,
      // the final NOFOLLOW open stays relative to this same inode even if its name moves.
      const pinnedTarget = await resolvePinned(resolved);
      if (pinnedTarget === null) return null;
      confinedRealPath(handle.scope, handle.root, pinnedTarget);
      if (pinnedTarget !== resolved) throw outsideRoot(handle.scope, target, handle.root);
      const file = await openConfined(handle.scope, handle.root, resolved, resolved);
      if (file === null) return null;
      try {
        return await file.readText();
      } finally {
        await file.close();
      }
    });
  }
  /** One note's text, in a pinned session of its own. */
  function readNoteText(handle: VerifiedDir, slug: string): Promise<string | null> {
    return inPinnedDirectory(handle, () => readEntryText(handle, entryPathIn(handle, slug)));
  }
  /** The confined handle for a file, or `null` when it vanished; a link at it is refused. */
  async function openConfined(
    scope: MemoryScope,
    root: string,
    path: string,
    target: string,
  ): Promise<OpenedFile | null> {
    try {
      return await _memoryStoreDeps.open(target, READ_FLAGS);
    } catch (error) {
      if (isMissing(error)) return null;
      if (isSymlinkLoop(error)) throw outsideRoot(scope, path, root, error);
      throw error;
    }
  }

  async function readNote(scope: MemoryScope, slug: string): Promise<MemoryNote | null> {
    validSlug(slug);
    const handle = await openNotesDir(scope);
    if (handle === null) return null;
    const text = await readNoteText(handle, slug);
    return text === null ? null : parseMemoryNote(text);
  }

  async function writeNote(note: MemoryNote): Promise<void> {
    validSlug(note.slug);
    const handle = await ensureNotesDir(note.scope);
    const target = entryPathIn(handle, note.slug);
    // Check an existing symlink's destination, but replace the note entry itself atomically.
    confinedRealPath(handle.scope, handle.root, target);
    // All staging, rename and cleanup operations stay relative to the pinned parent.
    // Checks report a moved directory without touching its replacement.
    await inPinnedDirectory(handle, () =>
      writeFileAtomic(target, serializeMemoryNote(note), {
        beforePublish: () => assertSameDirectory(handle),
        afterPublish: (stage) => verifyPublished(handle, target, stage),
      }),
    );
  }
  /** The note that was just published must be inside the root, and it is taken back if not. */
  async function verifyPublished(handle: VerifiedDir, target: string, stage: Identity): Promise<void> {
    try {
      await assertSameDirectory(handle);
      confinedRealPath(handle.scope, handle.root, target);
    } catch (error) {
      const landed = await pinnedOperation<Identity>(target, "stat");
      if (landed !== null && sameIdentity(landed, stage)) await _memoryStoreDeps.rm(target, { force: true });
      throw error;
    }
  }

  function inPinnedDirectory<T>(handle: VerifiedDir, action: () => Promise<T>): Promise<T> {
    return _memoryStoreDeps.pin(
      {
        path: handle.dir,
        identity: handle.identity,
        changed: () => outsideRoot(handle.scope, handle.dir, handle.root),
      },
      action,
    );
  }

  async function deleteNote(scope: MemoryScope, slug: string): Promise<void> {
    validSlug(slug);
    const handle = await openNotesDir(scope);
    if (handle === null) return;
    const entry = entryPathIn(handle, slug);
    // A note that resolves out of the root is refused, then the directory is proved to be
    // the one verified: what goes is that entry, in that directory, never a link's target.
    confinedRealPath(handle.scope, handle.root, entry);
    await inPinnedDirectory(handle, async () => {
      await assertSameDirectory(handle);
      await _memoryStoreDeps.rm(entry, { force: true });
      await assertSameDirectory(handle);
    });
  }
  /** The listing reports a skipped file once, whatever the reason, and carries on. */
  function warnSkipped(path: string, error: unknown): void {
    const message = isOutsidePath(error)
      ? "skipping memory note outside the scope root"
      : "skipping unreadable memory note";
    logger.warn("memory", message, { path, error: errorMessage(error) });
  }
  /** The note one listed file holds, or `null` when the file is skipped (never throws). */
  async function listedNote(handle: VerifiedDir, slug: string): Promise<MemoryNote | null> {
    try {
      const text = await readEntryText(handle, entryPathIn(handle, slug));
      // A file that vanished between the listing and the read is skipped without a warning.
      return text === null ? null : parseMemoryNote(text);
    } catch (error) {
      warnSkipped(entryName(handle, slug), error);
      return null;
    }
  }

  /** The notes of one listing, read inside the one pinned session that session opened. */
  async function listedNotes(handle: VerifiedDir, slugs: readonly string[]): Promise<MemoryNote[]> {
    const notes: MemoryNote[] = [];
    for (const slug of slugs) {
      const note = await listedNote(handle, slug);
      if (note !== null) notes.push(note);
    }
    return notes;
  }

  async function listNotes(scope: MemoryScope): Promise<MemoryNote[]> {
    const handle = await openNotesDir(scope);
    if (handle === null) return [];
    await assertSameDirectory(handle);
    let entries: Dirent[];
    try {
      entries = await _memoryStoreDeps.readdir(handle.dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    // Names read from a directory that was replaced while it was listed cannot be trusted to
    // name its notes, and a listing cannot tell — so it is refused rather than returned.
    await assertSameDirectory(handle);
    const slugs = entries
      .map((entry) => noteSlugIn(entry))
      .filter((slug): slug is string => slug !== null)
      .sort(byCodePoint);
    if (slugs.length === 0) return [];
    return await inPinnedDirectory(handle, () => listedNotes(handle, slugs));
  }

  /** A scope's root directory itself, verified and identified: records sit directly inside it. */
  async function openScopeDir(scope: MemoryScope): Promise<VerifiedDir | null> {
    const root = scope === "user" ? paths.userDir : paths.projectDir;
    if (root === null) throw scopeUnavailable(scope);
    const dir = confinedRealPath(scope, root, root);
    const identity = await identityAt(dir);
    return identity === null ? null : { scope, root, spelling: root, dir, identity };
  }

  /** One record file's text, read under the project directory's pin, never outside it. */
  async function readRecordText(path: string): Promise<string | null> {
    const handle = await openScopeDir("project");
    if (handle === null) return null;
    const entry = join(handle.dir, basename(path));
    return await inPinnedDirectory(handle, () => readEntryText(handle, entry));
  }
  /** Publish one record file, creating its directory on demand: staging needs one. */
  async function writeRecordFile(path: string, text: string): Promise<void> {
    await _memoryStoreDeps.mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, text);
  }
  /** One skipped mirror line, reported once, naming the line so it can be found. */
  function warnSkippedDecision(line: number): void {
    logger.warn("memory", "skipping a decisions line that is not a memory decision", {
      path: paths.decisions,
      line,
    });
  }

  function warnSkippedPendingForget(line: number): void {
    logger.warn("memory", "skipping a pending-forgets line that is not a pending forget", {
      path: paths.pendingForgets,
      line,
    });
  }

  async function readDecisions(): Promise<MemoryDecision[]> {
    return decodeRecordLines(await readRecordText(paths.decisions), parseDecisionLine, warnSkippedDecision);
  }

  async function writeDecisions(decisions: readonly MemoryDecision[]): Promise<void> {
    await writeRecordFile(paths.decisions, encodeRecordLines(decisions));
  }

  async function readPendingForgets(): Promise<MemoryPendingForget[]> {
    const text = await readRecordText(paths.pendingForgets);
    return decodeRecordLines(text, parsePendingForgetLine, warnSkippedPendingForget);
  }

  /** The record rewritten whole; every entry's slug must be one a note can carry. */
  async function writePendingForgets(entries: readonly MemoryPendingForget[]): Promise<void> {
    for (const entry of entries) validSlug(entry.slug);
    await writeRecordFile(paths.pendingForgets, encodeRecordLines(entries));
  }

  async function readSyncState(): Promise<MemorySyncState> {
    const text = await readRecordText(paths.syncState);
    // A missing file is the state of a store that has never synced; nothing to report.
    if (text === null) return defaultSyncState();
    const state = parseSyncStateText(text);
    if (state !== null) return state;
    logger.warn("memory", "memory sync state is unreadable; using the default state", { path: paths.syncState });
    return defaultSyncState();
  }

  async function writeSyncState(state: MemorySyncState): Promise<void> {
    await writeRecordFile(paths.syncState, `${JSON.stringify(state)}\n`);
  }

  /** The generated index of one scope: the user index is the one a store may not have. */
  function indexPathFor(scope: MemoryScope): string {
    const path = scope === "user" ? paths.userIndex : paths.index;
    if (path === null) throw scopeUnavailable(scope);
    return path;
  }

  async function writeIndex(scope: MemoryScope, text: string): Promise<void> {
    await writeRecordFile(indexPathFor(scope), text);
  }

  return {
    paths,
    readNote,
    writeNote,
    deleteNote,
    listNotes,
    readDecisions,
    writeDecisions,
    readPendingForgets,
    writePendingForgets,
    readSyncState,
    writeSyncState,
    writeIndex,
  };
}
