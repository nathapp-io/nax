/**
 * Repo-committed team notes.
 *
 * A repo note is a feature-1 note file committed at `<repoRoot>/.nax/memory/<slug>.md`,
 * so the whole team shares it through the repository instead of through a
 * machine-local mirror. Reading is the only operation: no tool or command ever
 * writes or deletes one.
 *
 * This module owns the per-file rules — which names are candidates (rule 2) and
 * what makes a candidate acceptable (rule 3). Everything here is repo-scoped:
 * the only anchor is the repository root, and nothing reaches outside the
 * mirror directories resolved by `paths.ts`. Safety about the directory itself
 * (absent, symlinked, unreadable) and the accepted-note cap are separate rules.
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
 * Declared here because it bounds what this read can return; the cap itself is
 * enforced by the accepted-note limit rule, which sits alongside these per-file
 * checks rather than inside them.
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
function acceptedNote(text: string, name: string, path: string, logger: MemoryLogger): MemoryNote | null {
  const note = parsedOrNull(text, path, logger);
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
  return acceptedNote(text, name, path, logger);
}

/** The directory whose top level holds the repository's notes. */
function repoNotesDir(repoRoot: string): string {
  return join(repoRoot, PROJECT_NAX_DIR, REPO_MEMORY_DIR_NAME);
}

/**
 * The candidate names — the directory's top-level `.md` entries, in file-name
 * order. A directory that cannot be listed contributes none: whether that is
 * an absent directory, a symlink or a permissions failure is the directory
 * rule's question, not a per-file one.
 */
async function candidateNames(dir: string): Promise<readonly string[]> {
  let entries: readonly string[];
  try {
    entries = await _repoNotesDeps.readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith(NOTE_EXTENSION)).sort(codeUnitOrder);
}

/**
 * Read the repository's committed team notes.
 *
 * Never throws for repository content: a candidate that breaks a rule is
 * logged and counted, and `notes` holds only the notes that passed every rule.
 *
 * @param input.repoRoot - Absolute path to the repository root (the `.nax` anchor)
 * @param input.logger - Logger the one-warn-per-skip lines go through
 */
export async function readRepoNotes(input: {
  readonly repoRoot: string;
  readonly logger: MemoryLogger;
}): Promise<RepoNotes> {
  const dir = repoNotesDir(input.repoRoot);
  const accepted: MemoryNote[] = [];
  let skipped = 0;
  for (const name of await candidateNames(dir)) {
    const note = await readCandidate(join(dir, name), name, input.logger);
    if (note === null) {
      skipped += 1;
    } else {
      accepted.push(note);
    }
  }
  return { notes: accepted.sort(bySlug), skipped };
}
