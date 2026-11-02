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
 * Every read and directory operation goes through `_memoryStoreDeps`, so a test
 * injects a failing `readFile` / `readdir` there; the write path's seam is
 * `_atomicWriteDeps` inside `#src/internal/atomic-write`.
 *
 * Every note path is confined twice over: the slug is validated (pure, before any
 * filesystem call), then both the scope's notes directory and the note's own path
 * must resolve inside the scope root (`isInside`, symlink-tolerant). A store whose
 * `notes` directory — or one note file — has been replaced by a link pointing out
 * of the root is `MEMORY_PATH_OUTSIDE`: a read, a write and a delete refuse, and
 * `listNotes` skips that one file with a `warn` so the rest of the listing survives.
 *
 * A check that is not repeated at the point of use leaves a window: whatever is
 * swapped in between is followed. So each operation verifies again immediately
 * before its syscall (`confinedRealPath`, the last look) and a read copies no bytes
 * from a link (`O_NOFOLLOW`), which turns a link that appears mid-operation into
 * `MEMORY_PATH_OUTSIDE` instead of a file from outside the root. What remains is the
 * gap between that last look and the syscall itself; closing it needs a directory
 * handle and `openat`, which Node does not expose, so it is not claimed here.
 */
import type { Dirent } from "node:fs";
import { constants } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
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
 * The read flag that makes a read refuse a symlink instead of following it.
 *
 * A note read is a check-then-use sequence: the path is resolved and confined, and only
 * then opened. `O_NOFOLLOW` closes that gap for the last component — a link swapped in
 * after the check fails with `ELOOP` rather than delivering a file from outside the root.
 * Every path reaching the read is already symlink-free (it is the resolved form), so the
 * flag never refuses a legitimate note, including one reached through an in-root link.
 */
const NO_FOLLOW: number = constants.O_NOFOLLOW;

type ReadText = (path: string, options: { encoding: "utf8"; flag: number }) => Promise<string>;
type MakeDir = (path: string, options: { recursive: true }) => Promise<string | undefined>;
/** Directory entries carry their type, so a listing never has to open a path to learn what it is. */
type ReadDirEntries = (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
type RemoveFile = (path: string, options: { force: true }) => Promise<void>;

/** Injectable for tests that simulate an unreadable note or an unlistable directory. */
export const _memoryStoreDeps: { readFile: ReadText; mkdir: MakeDir; readdir: ReadDirEntries; rm: RemoveFile } = {
  readFile: (path, options) => readFile(path, options),
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

/** One note file a directory listing turned up. */
interface NoteCandidate {
  readonly slug: string;
  readonly path: string;
}

/**
 * The note a directory entry can hold, or `null` when it is not a `<slug>.md` file.
 *
 * A note is a regular file or a link to one: a directory named `x.md`, a FIFO or a socket is
 * not a note, and is never opened. (US-004's confinement decides what a link may point at.)
 */
function noteCandidateIn(notesDir: string, entry: Dirent): NoteCandidate | null {
  if (!entry.isFile() && !entry.isSymbolicLink()) return null;
  const name = entry.name;
  if (!name.endsWith(NOTE_SUFFIX)) return null;
  const slug = name.slice(0, -NOTE_SUFFIX.length);
  if (!MEMORY_SLUG_RE.test(slug)) return null;
  return { slug, path: join(notesDir, name) };
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

/** The scope root a note must stay inside, and the note's path as the caller's spelling of it. */
interface NoteTarget {
  readonly root: string;
  readonly path: string;
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
   * The note's path, validated before anything touches the filesystem, and confined.
   *
   * `isInside` resolves a path that does not exist through its nearest existing
   * ancestor, so checking the file covers the existing-target case (`<slug>.md` is a
   * link to elsewhere) as well as the ordinary one: a write stages its bytes under
   * this same directory, so a confined notes directory confines the note.
   */
  function noteTarget(scope: MemoryScope, slug: string): NoteTarget {
    if (!MEMORY_SLUG_RE.test(slug)) throw invalidSlug(slug);
    const { root, notesDir } = confinedNotesDir(scope);
    const path = join(notesDir, `${slug}${NOTE_SUFFIX}`);
    if (!isInside(root, path)) throw outsideRoot(scope, path, root);
    return { root, path };
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

  /**
   * One note file's text, or `null` when it (or its directory) is not there.
   *
   * Check and use are the same resolved path, and the read will not follow a link: a
   * symlink swapped in after the check fails with `ELOOP`, which is reported as the
   * out-of-root path it is. A caller's own spelling of `path` is what the error names.
   */
  async function readNoteText(scope: MemoryScope, root: string, path: string): Promise<string | null> {
    const target = confinedRealPath(scope, root, path);
    try {
      return await _memoryStoreDeps.readFile(target, { encoding: "utf8", flag: NO_FOLLOW });
    } catch (error) {
      if (isMissing(error)) return null;
      if (isSymlinkLoop(error)) throw outsideRoot(scope, path, root, error);
      throw error;
    }
  }

  async function readNote(scope: MemoryScope, slug: string): Promise<MemoryNote | null> {
    const { root, path } = noteTarget(scope, slug);
    const text = await readNoteText(scope, root, path);
    return text === null ? null : parseMemoryNote(text);
  }

  async function writeNote(note: MemoryNote): Promise<void> {
    const { root, path } = noteTarget(note.scope, note.slug);
    await _memoryStoreDeps.mkdir(dirname(path), { recursive: true });
    // Last look: the directory just ensured — or anything above it — may have been swapped.
    // `rename` at the end replaces a link at the target instead of writing through it.
    confinedRealPath(note.scope, root, path);
    await writeFileAtomic(path, serializeMemoryNote(note));
  }

  async function deleteNote(scope: MemoryScope, slug: string): Promise<void> {
    // `force` makes an absent note — and an absent notes directory — a no-op. Removing a
    // directory entry cannot follow a link out of the root: the entry, not its target, goes.
    await _memoryStoreDeps.rm(noteTarget(scope, slug).path, { force: true });
  }

  /** The listing reports a skipped file once, whatever the reason, and carries on. */
  function warnSkipped(path: string, error: unknown): void {
    const message = isOutsidePath(error)
      ? "skipping memory note outside the scope root"
      : "skipping unreadable memory note";
    logger.warn("memory", message, { path, error: errorMessage(error) });
  }

  /** The note one listed file holds, or `null` when the file is skipped (never throws). */
  async function listedNote(scope: MemoryScope, root: string, path: string): Promise<MemoryNote | null> {
    try {
      const text = await readNoteText(scope, root, path);
      // A file that vanished between the listing and the read is skipped without a warning.
      return text === null ? null : parseMemoryNote(text);
    } catch (error) {
      warnSkipped(path, error);
      return null;
    }
  }

  async function listNotes(scope: MemoryScope): Promise<MemoryNote[]> {
    const { root, notesDir } = confinedNotesDir(scope);
    let entries: Dirent[];
    try {
      entries = await _memoryStoreDeps.readdir(notesDir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const candidates = entries
      .map((entry) => noteCandidateIn(notesDir, entry))
      .filter((candidate): candidate is NoteCandidate => candidate !== null)
      .sort((a, b) => byCodePoint(a.slug, b.slug));
    const notes: MemoryNote[] = [];
    for (const { path } of candidates) {
      const note = await listedNote(scope, root, path);
      if (note !== null) notes.push(note);
    }
    return notes;
  }

  return { paths, readNote, writeNote, deleteNote, listNotes };
}
