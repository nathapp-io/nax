/**
 * Repo-committed team notes.
 *
 * A repo note is a feature-1 note file committed at `<repoRoot>/.nax/memory/<slug>.md`,
 * so the whole team shares it through the repository instead of through a
 * machine-local mirror. Reading is the only operation: no tool or command ever
 * writes or deletes one.
 *
 * This module owns all four repo-note rules: the directories themselves are
 * never entered through a symlink, an absent one reads as "no notes" and an
 * unreadable one reads as "no notes" behind one warn (rule 1); which names are
 * candidates (rule 2); what makes a candidate acceptable (rule 3); and the cap
 * on how many notes one read returns (rule 4). Everything here is repo-scoped:
 * the only anchor is the repository root, and nothing reaches outside the
 * directories under `<repoRoot>/.nax`.
 *
 * The directory checks run first because they are the cheap answer: a symlinked
 * `.nax` or `.nax/memory` is refused before a single entry is listed, so a
 * committed link cannot turn this read into a walk of somewhere else on disk.
 * The cap then bounds the work a repository can make a read do — a repository
 * with a thousand committed notes still costs one listing and
 * `REPO_NOTES_MAX` reads.
 *
 * A candidate is measured with `lstat` and rejected on size *before* it is read,
 * because a repo note is untrusted repository content: the file can be a
 * symlink to somewhere else, or large enough that reading it is itself the
 * problem. Rejections are recoverable by design, so each one is a `warn` naming
 * the path and the reason and is counted in `skipped` — nothing escapes this
 * module as a throw. Because the measurement and the read are two steps, the
 * read re-checks the file through a handle opened without following a symlink,
 * so a path swapped for a link in between is refused rather than followed.
 */

import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { findSecret, type MemoryNote, parseMemoryNote } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { PROJECT_NAX_DIR } from "@/config";
import { NaxError } from "@/errors";
import type { MemoryLogger } from "./paths";

/** Stage every repo-note log line is written under. */
const LOG_STAGE = "memory";
/** The directory, under `<repoRoot>/.nax`, whose top level holds repo notes. */
const REPO_MEMORY_DIR_NAME = "memory";
/** Only top-level names with this suffix are candidates; the rest are ignored. */
const NOTE_EXTENSION = ".md";
/** The `source` an accepted repo note carries: it was committed, not saved by an agent. */
const REPO_SOURCE = "repo";

/** A repo note file larger than this is never read: 16 KiB. */
export const REPO_NOTE_MAX_FILE_BYTES = 16_384;

/**
 * The most accepted repo notes one read returns.
 *
 * The remaining candidates are neither measured nor read once the cap is
 * reached; they are counted in `skipped` and announced by one warn, so a
 * repository cannot make a read unbounded merely by committing more notes.
 */
export const REPO_NOTES_MAX = 200;

/** What one read of the repository's team notes found. */
export interface RepoNotes {
  /** Accepted notes, `source` replaced by `"repo"`, sorted by slug. */
  readonly notes: readonly MemoryNote[];
  /** How many candidates a per-file rule rejected. */
  readonly skipped: number;
}

/**
 * The flags the read opens with: read-only, and never follow a symlink at the
 * path (`O_NOFOLLOW`; a swapped-in symlink fails with `ELOOP`). `O_NONBLOCK`
 * keeps a FIFO substituted for the candidate from blocking the open — the
 * handle's `stat` then rejects it as not a regular file. `O_NOFOLLOW` is a
 * POSIX flag; on a platform that does not define it the handle checks below
 * still reject anything that is not a regular file of an allowed size.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK;

/**
 * The refusal for a candidate that stopped being a readable regular note
 * between the measurement and the open.
 *
 * It is thrown only because `readFile` returns a `Promise<string>` and has no
 * other channel; the caller catches it immediately and turns it into the same
 * `repo note skipped` warn every other rejection produces.
 */
function unsafeCandidate(path: string, problem: string): NaxError {
  return new NaxError(`[memory] repo note ${problem} at open: ${path}`, "MEMORY_REPO_NOTE_UNSAFE", {
    stage: LOG_STAGE,
    path,
  });
}

/**
 * One candidate's text, read through a handle opened without following a
 * symlink.
 *
 * `lstat` measured a *path*; between that measurement and the read the path can
 * be swapped for a symlink, and a plain `readFile` would then serve a file from
 * anywhere on disk. Opening with `O_NOFOLLOW` and re-checking type and size on
 * the handle — then reading from that same handle — makes the file measured the
 * file consumed.
 */
async function readRegularText(path: string): Promise<string> {
  const handle = await open(path, READ_FLAGS);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw unsafeCandidate(path, "is not a regular file");
    if (info.size > REPO_NOTE_MAX_FILE_BYTES) {
      throw unsafeCandidate(path, `is larger than ${REPO_NOTE_MAX_FILE_BYTES} bytes`);
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

/**
 * Filesystem seam for tests. `lstat` is the cheap pre-measurement that names a
 * skip reason, and `readFile` is the authoritative no-follow read — a test needs
 * to replace it to exercise a read failure no permission bit can produce
 * portably.
 */
export const _repoNotesDeps: {
  lstat: (path: string) => Promise<Stats>;
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
} = {
  lstat: (path: string): Promise<Stats> => lstat(path),
  readdir: (path: string): Promise<string[]> => readdir(path),
  readFile: (path: string): Promise<string> => readRegularText(path),
};

/** File-name order, as code units: a read's candidate order is not the OS's. */
function codeUnitOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Slug order for the accepted notes. */
function bySlug(left: MemoryNote, right: MemoryNote): number {
  return codeUnitOrder(left.slug, right.slug);
}

/** Log one skip and hand back the `null` the caller returns. */
function skip(logger: MemoryLogger, path: string, reason: string): null {
  logger.warn(LOG_STAGE, "repo note skipped", { path, reason });
  return null;
}

/**
 * `lstat` the candidate, or `null` after logging when it cannot be measured —
 * an entry may vanish between the directory listing and here.
 */
async function measuredOrNull(path: string, logger: MemoryLogger): Promise<Stats | null> {
  try {
    return await _repoNotesDeps.lstat(path);
  } catch (error) {
    return skip(logger, path, `cannot stat: ${errorMessage(error)}`);
  }
}

/** The candidate's text, or `null` after logging that reading it failed. */
async function textOrNull(path: string, logger: MemoryLogger): Promise<string | null> {
  try {
    return await _repoNotesDeps.readFile(path);
  } catch (error) {
    return skip(logger, path, `read failed: ${errorMessage(error)}`);
  }
}

/** The note the file holds, or `null` after logging that it is not a note file. */
function parsedOrNull(text: string, path: string, logger: MemoryLogger): MemoryNote | null {
  try {
    return parseMemoryNote(text);
  } catch (error) {
    return skip(logger, path, `invalid note: ${errorMessage(error)}`);
  }
}

/** The first secret in a note's description or body, as its kind, never as text. */
function noteSecret(note: MemoryNote): { readonly kind: string } | null {
  return findSecret(note.description) ?? findSecret(note.body);
}

/**
 * The note `text` describes, or `null` after logging the rule it broke.
 *
 * The frontmatter `slug` must equal the file name so the file a teammate edits
 * is the note every surface serves; `scope` and `status` are the two fields a
 * mirror note may vary in and a repo note may not.
 */
function withRepoDefaults(text: string, name: string, modifiedAt: Date): string {
  const lines = text.split("\n");
  const close = lines.findIndex((line, index) => index > 0 && /^---[ \t]*\r?$/.test(line));
  if (close === -1) return text;
  const keys = new Set(
    lines.slice(1, close).flatMap((line) => {
      const match = /^(id|scope|status|source|updatedAt):/.exec(line);
      return match === null ? [] : [match[1]];
    }),
  );
  const defaults: readonly [string, string][] = [
    ["id", name.slice(0, name.length - NOTE_EXTENSION.length)],
    ["scope", "project"],
    ["status", "active"],
    ["source", REPO_SOURCE],
    ["updatedAt", modifiedAt.toISOString()],
  ];
  lines.splice(close, 0, ...defaults.filter(([key]) => !keys.has(key)).map(([key, value]) => `${key}: ${value}`));
  return lines.join("\n");
}

function acceptedNote(
  text: string,
  name: string,
  modifiedAt: Date,
  path: string,
  logger: MemoryLogger,
): MemoryNote | null {
  const note = parsedOrNull(withRepoDefaults(text, name, modifiedAt), path, logger);
  if (note === null) return null;
  if (note.slug !== name.slice(0, name.length - NOTE_EXTENSION.length)) {
    return skip(logger, path, "slug does not match the file name");
  }
  if (note.scope !== "project") return skip(logger, path, "scope is not project");
  if (note.status !== "active") return skip(logger, path, "status is not active");
  const secret = noteSecret(note);
  if (secret !== null) return skip(logger, path, `secret (${secret.kind})`);
  return { ...note, source: REPO_SOURCE };
}

/** One candidate: measure, read, then hold it to the rules. */
async function readCandidate(path: string, name: string, logger: MemoryLogger): Promise<MemoryNote | null> {
  const info = await measuredOrNull(path, logger);
  if (info === null) return null;
  if (!info.isFile()) return skip(logger, path, "not a regular file");
  if (info.size > REPO_NOTE_MAX_FILE_BYTES) return skip(logger, path, "too large");
  const text = await textOrNull(path, logger);
  if (text === null) return null;
  return acceptedNote(text, name, info.mtime, path, logger);
}

/**
 * The repository's `.nax` directory — the first of the two directories a repo
 * note read passes through.
 */
function repoNaxDir(repoRoot: string): string {
  return join(repoRoot, PROJECT_NAX_DIR);
}

/** The directory whose top level holds the repository's notes. */
function repoNotesDir(repoRoot: string): string {
  return join(repoNaxDir(repoRoot), REPO_MEMORY_DIR_NAME);
}

/**
 * Whether an error is the filesystem saying "no such entry".
 *
 * That is the one directory failure a repo-note read treats as silence: a
 * repository that has never used memory is the normal case, not a problem.
 */
function isMissingError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** What `lstat` said about one of the two directories the read passes through. */
type DirCheck =
  | { readonly state: "usable" }
  | { readonly state: "missing" }
  | { readonly state: "symlink" }
  | { readonly state: "unreadable"; readonly error: string };

/**
 * Inspect one directory on the way to the notes.
 *
 * `lstat`, not `stat`: a symlink has to be seen *as* a symlink. A committed
 * `.nax/memory` pointing at `$HOME` would otherwise turn this read into a walk
 * of somewhere else entirely, which no per-file rule could catch, because every
 * entry it listed would look like an ordinary note candidate.
 */
async function checkDir(path: string): Promise<DirCheck> {
  try {
    const info = await _repoNotesDeps.lstat(path);
    return info.isSymbolicLink() ? { state: "symlink" } : { state: "usable" };
  } catch (error) {
    return isMissingError(error) ? { state: "missing" } : { state: "unreadable", error: errorMessage(error) };
  }
}

/**
 * Whether both directories are usable, after logging the one warn a refusal
 * owes — a symlink names the directory that is the link, and an unreadable one
 * names the directory plus the error behind it.
 *
 * The first unusable directory ends the walk: `dirs` is ordered outermost first,
 * so a symlinked `.nax` never causes a second `lstat` inside the tree it links to.
 */
async function dirsUsable(dirs: readonly string[], logger: MemoryLogger): Promise<boolean> {
  for (const path of dirs) {
    const check = await checkDir(path);
    if (check.state === "usable") continue;
    if (check.state === "symlink") {
      logger.warn(LOG_STAGE, "repo notes directory is a symlink", { path });
    } else if (check.state === "unreadable") {
      logger.warn(LOG_STAGE, "repo notes unreadable", { path, error: check.error });
    }
    return false;
  }
  return true;
}

/**
 * The candidate names — the directory's top-level `.md` entries, in file-name
 * order — or `null` once the directory itself could not be listed, which reads
 * as "no repo notes" after the one warn this logs.
 *
 * A directory that vanished between `dirsUsable` and here contributes no names
 * and no warn: nothing is wrong, there is simply nothing left to read.
 */
async function candidateNames(dir: string, logger: MemoryLogger): Promise<readonly string[] | null> {
  let entries: readonly string[];
  try {
    entries = await _repoNotesDeps.readdir(dir);
  } catch (error) {
    if (isMissingError(error)) return [];
    logger.warn(LOG_STAGE, "repo notes unreadable", { path: dir, error: errorMessage(error) });
    return null;
  }
  return entries.filter((name) => name.endsWith(NOTE_EXTENSION)).sort(codeUnitOrder);
}

/**
 * Read candidates in file-name order until `REPO_NOTES_MAX` notes are accepted.
 *
 * The candidates left over when the cap is reached are charged to `skipped`
 * behind one warn and never measured or read: a large set of committed notes
 * costs the repository one listing, not one read per file. Stopping in file-name
 * order (rather than after sorting by slug) keeps which notes a capped read
 * returns stable across machines, and the accepted notes are sorted by slug
 * afterwards so the caller never sees the file-name order.
 */
async function collectNotes(names: readonly string[], dir: string, logger: MemoryLogger): Promise<RepoNotes> {
  const accepted: MemoryNote[] = [];
  let skipped = 0;
  let index = 0;
  for (; index < names.length; index += 1) {
    if (accepted.length === REPO_NOTES_MAX) break;
    const name = names[index];
    const note = await readCandidate(join(dir, name), name, logger);
    if (note === null) {
      skipped += 1;
    } else {
      accepted.push(note);
    }
  }
  const leftOver = names.length - index;
  if (leftOver > 0) {
    logger.warn(LOG_STAGE, "repo notes over limit", { skipped: leftOver });
    skipped += leftOver;
  }
  return { notes: accepted.sort(bySlug), skipped };
}

/**
 * Read the repository's committed team notes.
 *
 * Never throws for repository content: a directory that is a symlink, missing
 * or unreadable reads as no notes (with the one warn rule 1 owes), a candidate
 * that breaks a per-file rule is logged and counted, and `notes` holds only the
 * notes that passed every rule.
 *
 * @param input.repoRoot - Absolute path to the repository root (the `.nax` anchor)
 * @param input.logger - Logger the one-warn-per-skip lines go through
 */
export async function readRepoNotes(input: {
  readonly repoRoot: string;
  readonly logger: MemoryLogger;
}): Promise<RepoNotes> {
  const dir = repoNotesDir(input.repoRoot);
  if (!(await dirsUsable([repoNaxDir(input.repoRoot), dir], input.logger))) return { notes: [], skipped: 0 };
  const names = await candidateNames(dir, input.logger);
  if (names === null) return { notes: [], skipped: 0 };
  return collectNotes(names, dir, input.logger);
}
