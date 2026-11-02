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
 */
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentLogger } from "#src/infra/agent-logger";
import { errorMessage } from "#src/infra/errors";
import { NaxError } from "#src/infra/nax-error";
import { writeFileAtomic } from "#src/internal/atomic-write";
import { byCodePoint } from "#src/internal/sort";
import { parseMemoryNote, serializeMemoryNote } from "./note.ts";
import { MEMORY_SLUG_RE, type MemoryNote, type MemoryScope } from "./types.ts";

const ERROR_STAGE = "memory";
const INDEX_FILE = "MEMORY.md";
const NOTES_DIR = "notes";
const NOTE_SUFFIX = ".md";

type ReadText = (path: string, encoding: "utf8") => Promise<string>;
type MakeDir = (path: string, options: { recursive: true }) => Promise<string | undefined>;
/** Directory entries carry their type, so a listing never has to open a path to learn what it is. */
type ReadDirEntries = (path: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
type RemoveFile = (path: string, options: { force: true }) => Promise<void>;

/** Injectable for tests that simulate an unreadable note or an unlistable directory. */
export const _memoryStoreDeps: { readFile: ReadText; mkdir: MakeDir; readdir: ReadDirEntries; rm: RemoveFile } = {
  readFile: (path, encoding) => readFile(path, encoding),
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

export function createMemoryStore(input: {
  readonly projectDir: string;
  readonly userDir?: string | null;
  readonly logger: AgentLogger;
}): MemoryStore {
  const { logger } = input;
  const paths = memoryStorePaths(input.projectDir, dirOrNull(input.userDir));

  /** The notes directory of one scope; the user scope is the one that can be unavailable. */
  function notesDirFor(scope: MemoryScope): string {
    if (scope !== "user") return paths.notesDir;
    if (paths.userNotesDir === null) throw scopeUnavailable(scope);
    return paths.userNotesDir;
  }

  /** The note's path, validated before anything touches the filesystem. */
  function notePath(scope: MemoryScope, slug: string): string {
    const notesDir = notesDirFor(scope);
    if (!MEMORY_SLUG_RE.test(slug)) throw invalidSlug(slug);
    return join(notesDir, `${slug}${NOTE_SUFFIX}`);
  }

  /** One note file's text, or `null` when it (or its directory) is not there. */
  async function readNoteText(path: string): Promise<string | null> {
    try {
      return await _memoryStoreDeps.readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async function readNote(scope: MemoryScope, slug: string): Promise<MemoryNote | null> {
    const text = await readNoteText(notePath(scope, slug));
    return text === null ? null : parseMemoryNote(text);
  }

  async function writeNote(note: MemoryNote): Promise<void> {
    const path = notePath(note.scope, note.slug);
    await _memoryStoreDeps.mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, serializeMemoryNote(note));
  }

  async function deleteNote(scope: MemoryScope, slug: string): Promise<void> {
    // `force` makes an absent note — and an absent notes directory — a no-op.
    await _memoryStoreDeps.rm(notePath(scope, slug), { force: true });
  }

  async function listNotes(scope: MemoryScope): Promise<MemoryNote[]> {
    const notesDir = notesDirFor(scope);
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
      try {
        notes.push(parseMemoryNote(await _memoryStoreDeps.readFile(path, "utf8")));
      } catch (error) {
        // One note's problem never fails the listing: report the file and carry on.
        logger.warn("memory", "skipping unreadable memory note", { path, error: errorMessage(error) });
      }
    }
    return notes;
  }

  return { paths, readNote, writeNote, deleteNote, listNotes };
}
