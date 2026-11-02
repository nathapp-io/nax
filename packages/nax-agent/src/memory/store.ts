/**
 * File-backed note mirror. Slugs are validated before I/O; directory and existing
 * note targets must resolve inside their scope root. Reads use identity-verified
 * descriptors; listings reject directory replacement and skip escaping files.
 *
 * Mutations run in a dedicated helper whose verified cwd pins the parent inode.
 * Stage creation, publication, deletion and cleanup are cwd-relative there: a
 * replacement at the original path cannot receive any of these operations.
 * The caller's global cwd is never changed. Post-checks report moved directories;
 * they are not the mechanism that prevents access to replacements.
 */
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { pinnedOperation, withPinnedDirectory } from "#src/internal/pinned-directory";
import { isInside, realOrRaw } from "#src/internal/realpath";
import { byCodePoint } from "#src/internal/sort";
import { parseMemoryNote, serializeMemoryNote } from "./note.ts";
import { MEMORY_SLUG_RE, type MemoryNote, type MemoryScope } from "./types.ts";

const ERROR_STAGE = "memory";
const INDEX_FILE = "MEMORY.md";
const NOTES_DIR = "notes";
const NOTE_SUFFIX = ".md";

/** Resolved reads refuse final-component links and prove the opened file's identity. */
const READ_FLAGS: number = constants.O_RDONLY | constants.O_NOFOLLOW;

interface Identity {
  readonly dev: number;
  readonly ino: number;
}

interface OpenedNote {
  stat(): Promise<Identity>;
  readText(): Promise<string>;
  close(): Promise<void>;
}

type OpenNote = (path: string, flags: number) => Promise<OpenedNote>;
type StatPath = (path: string) => Promise<Identity>;
type MakeDir = (path: string, options: { recursive: true }) => Promise<string | undefined>;
/** Directory entries carry their type, so a listing never has to open a path to learn what it is. */
type ReadDirEntries = (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
type RemoveFile = (path: string, options: { force: true }) => Promise<void>;

function identityOf(info: { dev: number; ino: number }): Identity {
  return { dev: info.dev, ino: info.ino };
}

/** I/O seam: reads prove descriptor identity; deletes use the active pinned parent. */
export const _memoryStoreDeps: {
  open: OpenNote;
  stat: StatPath;
  mkdir: MakeDir;
  readdir: ReadDirEntries;
  rm: RemoveFile;
} = {
  open: async (path, flags) => {
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
};

/** The files this store owns, spelled out once so every caller agrees on them. */
export interface MemoryStorePaths {
  readonly projectDir: string;
  readonly userDir: string | null;
  readonly index: string;
  readonly notesDir: string;
  readonly decisions: string;
  readonly syncState: string;
  readonly lock: string;
  readonly outboxDir: string;
  readonly userIndex: string | null;
  readonly userNotesDir: string | null;
}

/** The note half of the mirror; the decisions, sync state and index files join it in US-005. */
export interface MemoryStore {
  readonly paths: MemoryStorePaths;
  readNote(scope: MemoryScope, slug: string): Promise<MemoryNote | null>;
  writeNote(note: MemoryNote): Promise<void>;
  deleteNote(scope: MemoryScope, slug: string): Promise<void>;
  listNotes(scope: MemoryScope): Promise<MemoryNote[]>;
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
    decisions: join(projectDir, "decisions.jsonl"),
    syncState: join(projectDir, "sync.json"),
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
  /** Detect movement of the original path; mutation safety comes from the pinned cwd. */
  async function assertSameDirectory(handle: VerifiedDir): Promise<void> {
    const dir = confinedRealPath(handle.scope, handle.root, handle.dir);
    const identity = await identityAt(dir);
    if (dir !== handle.dir || identity === null || !sameIdentity(identity, handle.identity)) {
      throw outsideRoot(handle.scope, handle.dir, handle.root);
    }
  }
  /** One note's text, read from a handle whose identity is proved first. */
  async function readNoteText(handle: VerifiedDir, slug: string): Promise<string | null> {
    const entry = entryPathIn(handle, slug);
    const target = confinedRealPath(handle.scope, handle.root, entry);
    const expected = await identityAt(target);
    if (expected === null) return null;
    const file = await openNote(handle, entry, target);
    if (file === null) return null;
    try {
      if (!sameIdentity(await file.stat(), expected)) throw outsideRoot(handle.scope, entry, handle.root);
      return await file.readText();
    } finally {
      await file.close();
    }
  }
  /** The confined handle for a note, or `null` when it vanished; a link at it is refused. */
  async function openNote(handle: VerifiedDir, entry: string, target: string): Promise<OpenedNote | null> {
    try {
      return await _memoryStoreDeps.open(target, READ_FLAGS);
    } catch (error) {
      if (isMissing(error)) return null;
      if (isSymlinkLoop(error)) throw outsideRoot(handle.scope, entry, handle.root, error);
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
    return withPinnedDirectory(
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
      const text = await readNoteText(handle, slug);
      // A file that vanished between the listing and the read is skipped without a warning.
      return text === null ? null : parseMemoryNote(text);
    } catch (error) {
      warnSkipped(entryName(handle, slug), error);
      return null;
    }
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
    const notes: MemoryNote[] = [];
    for (const slug of slugs) {
      const note = await listedNote(handle, slug);
      if (note !== null) notes.push(note);
    }
    return notes;
  }

  return { paths, readNote, writeNote, deleteNote, listNotes };
}
