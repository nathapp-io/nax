/**
 * The file-backed mirror store: one directory of note files per scope, plus the
 * paths the rest of the memory feature reaches the mirror through.
 *
 * `<projectDir>/notes/<slug>.md` holds the project notes and
 * `<userDir>/notes/<slug>.md` the user notes (`userDir` is optional: without it
 * every user-scope call is `MEMORY_SCOPE_UNAVAILABLE`). A missing directory is
 * not an error — a read resolves `null` — while a note file whose frontmatter
 * does not parse is an error for `readNote`.
 *
 * Every read and directory operation goes through `_memoryStoreDeps` (`open`, `stat`,
 * `mkdir`, `readdir`, `rm`), so a test injects a failure — or a path swapped between the
 * store's check and its syscall — there; the write path's seam is `_atomicWriteDeps`
 * inside `#src/internal/atomic-write`.
 *
 * Every note path is confined twice over: the slug is validated (pure, before any
 * filesystem call), then both the scope's notes directory and the note's own path
 * must resolve inside the scope root (`isInside`, symlink-tolerant). A store whose
 * `notes` directory — or one note file — has been replaced by a link pointing out
 * of the root is `MEMORY_PATH_OUTSIDE`: a read, a write and a delete refuse, and
 * `listNotes` skips that one file with a `warn` so the rest of the listing survives.
 *
 * A check that is not repeated at the point of use leaves a window: whatever is swapped
 * in between is followed. So an operation works from a *verified directory* — the
 * directory's resolved path plus its `dev`/`ino` — rather than from a path string:
 *
 *   - a read copies bytes only from a descriptor whose identity matches the file the
 *     check resolved (`O_NOFOLLOW` covers the last component, the identity comparison
 *     covers every component above it), so a swap yields no content;
 *   - a write stages into the resolved directory and re-checks the directory's identity
 *     between staging and the rename (`writeFileAtomic`'s `beforePublish`), so a
 *     directory swapped during the write never receives the published note;
 *   - a delete and a listing use the verified directory's path and re-check its identity
 *     immediately before the syscall.
 *
 * What is left is the instant between an operation's last check and its own syscall for
 * the two operations that have no identity proof of their own (`readdir`, `unlink`).
 * Closing that needs a descriptor-relative syscall (`openat`/`unlinkat`); Node exposes
 * none, and `/dev/fd/<dirfd>/name` is not traversable on macOS, so it is not claimed.
 */
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { isInside, realOrRaw } from "#src/internal/realpath";
import { byCodePoint } from "#src/internal/sort";
import { parseMemoryNote, serializeMemoryNote } from "./note.ts";
import { MEMORY_SLUG_RE, type MemoryNote, type MemoryScope } from "./types.ts";

const ERROR_STAGE = "memory";
const INDEX_FILE = "MEMORY.md";
const NOTES_DIR = "notes";
const NOTE_SUFFIX = ".md";

/**
 * How a note is opened for reading: `O_NOFOLLOW` refuses a link at the final component.
 *
 * Every path reaching the open is already the resolved form, so the flag never refuses a
 * legitimate note (including one reached through an in-root link). It is one of two
 * guards: the other is the identity check on the opened handle, which catches a link — or
 * a whole directory — swapped in above the final component.
 */
const READ_FLAGS: number = constants.O_RDONLY | constants.O_NOFOLLOW;

/** The identity of a file or directory: what it is, independent of the path that names it. */
interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** An opened note: its identity, its text, and the close that must follow. */
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

/** The part of `Stats` this module reads; narrowed so a stubbed identity type-checks. */
function identityOf(info: { dev: number; ino: number }): Identity {
  return { dev: info.dev, ino: info.ino };
}

/**
 * Injectable for tests that simulate an unreadable note, an unlistable directory or a
 * path swapped between the store's check and its syscall.
 *
 * Reads go through `open` rather than a path-based `readFile` on purpose: the bytes are
 * only read from a handle whose identity has been compared with the file the confinement
 * check resolved, which a `readFile(path)` cannot express.
 */
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
  rm: (path, options) => rm(path, options),
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

/** Whether the error says the file — or its directory — is simply not there. */
function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/**
 * The slug a directory entry names, or `null` when it is not a `<slug>.md` note.
 *
 * A note is a regular file or a link to one: a directory named `x.md`, a FIFO or a socket is
 * not a note, and is never opened. (The confinement decides what a link may point at.)
 */
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

/** Whether the error says a note path resolved outside its scope root. */
function isOutsidePath(error: unknown): boolean {
  return error instanceof NaxError && error.code === "MEMORY_PATH_OUTSIDE";
}

/** Whether the error is the kernel refusing to follow a link (`O_NOFOLLOW`). */
function isSymlinkLoop(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ELOOP";
}

/** A scope's confinement root, and the notes directory that root has to contain. */
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

/** Whether two identities name the same file or directory. */
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

  /**
   * The notes directory of one scope, proved to sit inside that scope's root.
   *
   * The user scope is the one that can be unavailable (no `userDir`); a project or
   * user directory that has been replaced by a link pointing elsewhere is refused
   * here, before anything is read, listed or written through it.
   */
  function confinedNotesDir(scope: MemoryScope): ScopedNotesDir {
    const root = scope === "user" ? paths.userDir : paths.projectDir;
    const notesDir = scope === "user" ? paths.userNotesDir : paths.notesDir;
    if (root === null || notesDir === null) throw scopeUnavailable(scope);
    if (!isInside(root, notesDir)) throw outsideRoot(scope, notesDir, root);
    return { root, notesDir };
  }

  /**
   * The resolved form of `path`, refused unless it is still inside the root.
   *
   * This is the *last look* before a syscall, and the path the syscall then uses: a
   * directory or file replaced by a link between the first check and here resolves out
   * of the root and is refused, and what is returned has no symlink left in it.
   */
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

  /**
   * The scope's notes directory, resolved, confined and identified.
   *
   * This is the handle the rest of an operation is carried out against: its resolved path
   * (so no symlink is left in it) and its `dev`/`ino` (so a replacement is detectable even
   * when the path still resolves inside the root). `null` when the directory is not there —
   * for a read, a listing or a delete that is simply nothing to do.
   */
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

  /**
   * The last look at a directory before an operation that cannot prove it by handle.
   *
   * A directory moved aside and replaced — by a link, or by another real directory that
   * still resolves inside the root — keeps the path valid but changes what it is, so the
   * pinned identity is what refuses it.
   */
  async function assertSameDirectory(handle: VerifiedDir): Promise<void> {
    const dir = confinedRealPath(handle.scope, handle.root, handle.dir);
    const identity = await identityAt(dir);
    if (dir !== handle.dir || identity === null || !sameIdentity(identity, handle.identity)) {
      throw outsideRoot(handle.scope, handle.dir, handle.root);
    }
  }

  /**
   * One note's text, read from a handle whose identity is proved first.
   *
   * The bytes only come from a descriptor whose `dev`/`ino` equal those of the file the
   * confinement check resolved, so a directory or file swapped in between yields a
   * different identity and no content. `O_NOFOLLOW` covers the last component; the
   * identity check covers everything above it. `null` means the note is not there.
   */
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
    const target = confinedRealPath(handle.scope, handle.root, entryPathIn(handle, note.slug));
    // The stage is written into the verified directory, and the identity is checked again
    // between staging and the rename: a directory swapped during the write is refused
    // before the note is published into it. `rename` replaces a link at the target rather
    // than writing through it.
    await writeFileAtomic(target, serializeMemoryNote(note), {
      beforePublish: () => assertSameDirectory(handle),
    });
  }

  async function deleteNote(scope: MemoryScope, slug: string): Promise<void> {
    validSlug(slug);
    const handle = await openNotesDir(scope);
    if (handle === null) return;
    const entry = entryPathIn(handle, slug);
    // A note that resolves out of the root is refused, then the directory is proved to be
    // the one verified: what goes is that entry, in that directory, never a link's target.
    confinedRealPath(handle.scope, handle.root, entry);
    await assertSameDirectory(handle);
    await _memoryStoreDeps.rm(entry, { force: true });
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
