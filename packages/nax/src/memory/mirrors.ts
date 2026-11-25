/**
 * The mirror inventory: what each directory under `memory/projects` holds, and whether it
 * can be removed without losing anything.
 *
 * A mirror is a directory the project's memory host owns, named `<segment>-<hash8>`, and
 * nothing in the global directory lists them. Some hold notes a session built up, some hold
 * nothing but the probe that once opened them, and after compactions some hold archives.
 * This module answers one question per directory — counts, flags and the repository it
 * says it belongs to — from the directory alone, and one derived question over that
 * answer: is there anything in here worth keeping?
 *
 * Nothing here writes, locks or repairs, and nothing here throws. Three rules follow from
 * that. A mirror that is not there holds nothing, so an absent directory reads as the empty
 * answer. A mirror that is there but cannot be read is *unknown*, not empty: the path joins
 * `unreadable`, and a mirror with anything unreadable is never called prunable — a listing
 * line is cheap, and deleting notes this process could not see is not recoverable. And the
 * lock is reported rather than taken — `sync.lock` existing means a sync is in flight (or
 * died holding it) and this process cannot tell which, so a mirror that looks empty but is
 * locked is never called prunable either. A stale lock costs a listing line; a prune under a
 * live sync would cost the mirror.
 *
 * Presence is read with `lstat`: a lock or an archive at the name is something the mirror
 * holds, whether or not it can be followed, and being unable to follow it must not turn into
 * "nothing there".
 *
 * The file names are spelled here rather than imported: `packages/nax-agent/src/memory/
 * store-paths.ts` owns the layout for the code that reads and writes a mirror, and it
 * publishes no constant through the package entry. Keep the two in step.
 */
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { byCodePoint } from "@nathapp/nax-agent/internal";
import { ORIGIN_FILE } from "./mirror-origin";

/** The directory a mirror's note files sit in. */
const NOTES_DIR = "notes";
/** The directory a mirror's undelivered writes sit in. */
const OUTBOX_DIR = "outbox";
/** The generated index of one mirror. */
const INDEX_FILE = "MEMORY.md";
/** The provider and cursors a mirror's sync loop recorded. */
const SYNC_STATE_FILE = "sync.json";
/** The lock a sync holds while it runs. */
const SYNC_LOCK_FILE = "sync.lock";
/** The directory a compaction's pre-change notes and manifests sit in. */
const ARCHIVE_DIR = "archive";
/** The project's decision mirror, one JSON object per line. */
const DECISIONS_FILE = "decisions.jsonl";
/** The forgets a proposal has queued and not yet delivered, one JSON object per line. */
const PENDING_FORGETS_FILE = "pending-forgets.jsonl";
/** Only note files count: the extension the store's own listing accepts. */
const NOTE_SUFFIX = ".md";
/** Only outbox entry files count: a stage file (`<entry>.json.tmp`) is a write in progress. */
const OUTBOX_ENTRY_SUFFIX = ".json";

/** What one mirror holds, and the little it says about itself. */
export interface MemoryMirrorInfo {
  /** The mirror's absolute directory. */
  readonly dir: string;
  /** The directory's own name: the mirror's identity on disk. */
  readonly name: string;
  /** How many `notes/*.md` files it holds, both scopes' notes counted together. */
  readonly notes: number;
  /** How many undelivered writes its `outbox/` holds. */
  readonly outbox: number;
  /** The provider its `sync.json` records, or `null` when it has never synced. */
  readonly provider: string | null;
  /** The repository root its `origin.json` records, or `null` when it has never opened. */
  readonly originRoot: string | null;
  /** Whether that root is still on disk; `null` when there is no root to look for. */
  readonly rootExists: boolean | null;
  /** The byte size of its `MEMORY.md`, or 0 when it has none. */
  readonly indexBytes: number;
  /** Whether its `sync.lock` exists: a sync is in flight, or died holding the lock. */
  readonly inUse: boolean;
  /** Whether it holds an `archive/` entry, from any compaction, applied or rolled back. */
  readonly hasArchive: boolean;
  /** How many decisions its `decisions.jsonl` holds. */
  readonly decisions: number;
  /** How many forgets its `pending-forgets.jsonl` still holds. */
  readonly pendingForgets: number;
  /**
   * The paths inside the mirror this read could not get to, in the order it met them.
   *
   * Empty is the ordinary answer. A mirror with anything here was not fully read — its
   * counts are a lower bound, not the total — so `isPrunableMirror` refuses it: removing a
   * mirror whose contents this process could not see would delete what it could not count.
   */
  readonly unreadable: readonly string[];
}

/**
 * One mirror read by its own directory: what it holds, that it is not there, or that it could
 * not be read.
 *
 * Three answers rather than a nullable one, because the two ways a mirror can fail to produce
 * an inventory mean opposite things to a caller about to delete it — a directory that is gone
 * has nothing to lose, and one this process cannot read may hold everything.
 */
export type MemoryMirrorRead =
  | { readonly kind: "read"; readonly mirror: MemoryMirrorInfo }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" };

/** Whether an error is the filesystem saying the entry is not there at all. */
function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

/** One directory's entries, or `null` when it is absent or cannot be read. */
async function entriesIn(dir: string, unreadable: string[]): Promise<readonly Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // A directory that is not there holds nothing. One that cannot be listed holds something
    // this read cannot see, which a caller that prunes must never read as "empty".
    if (!isMissing(error)) unreadable.push(dir);
    return null;
  }
}

/** One file's text, or `null` when it is absent or cannot be read. */
async function textOrNull(path: string, unreadable: string[]): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    // A record the mirror does not hold (yet) is not a failure to report; one it holds and
    // will not give up is.
    if (!isMissing(error)) unreadable.push(path);
    return null;
  }
}

/** The JSON one file holds, or `null` when it is absent, unreadable or is not JSON. */
async function jsonOrNull(path: string, unreadable: string[]): Promise<unknown> {
  const text = await textOrNull(path, unreadable);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A record this file cannot hold is read as an absent one: a listing never refuses over
    // a hand-edited file, and neither the provider nor the origin decides what may be pruned.
    return null;
  }
}

/** One `stat` of a path — following a link, for a size — or `null` when there is nothing to read. */
async function statOrNull(path: string, unreadable: string[]): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (!isMissing(error)) unreadable.push(path);
    return null;
  }
}

/** One `lstat` of a path — the entry itself, link or not — or `null` when there is nothing there. */
async function lstatOrNull(path: string, unreadable: string[]): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    // Absence is the ordinary answer here: most of what a mirror may hold, it does not.
    if (!isMissing(error)) unreadable.push(path);
    return null;
  }
}

/**
 * Whether the path names a directory that is there.
 *
 * The origin's root is the one thing read here that lives *outside* the mirror, and whether
 * it can be looked at says nothing about what the mirror holds — a checkout on an unreadable
 * mount is a missing root, not an unreadable mirror.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether anything at all sits at the path — a lock may be a file, a directory or a link. */
async function present(path: string, unreadable: string[]): Promise<boolean> {
  return (await lstatOrNull(path, unreadable)) !== null;
}

/** The file's byte size, or 0 when it is absent or cannot be measured. */
async function fileBytes(path: string, unreadable: string[]): Promise<number> {
  return (await statOrNull(path, unreadable))?.size ?? 0;
}

/** How many records a JSONL file holds: its non-blank lines, one record each. */
async function lineCount(path: string, unreadable: string[]): Promise<number> {
  const text = await textOrNull(path, unreadable);
  if (text === null) return 0;
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/** The notes a mirror holds: one file per slug, both scopes counted. */
async function noteCount(dir: string, unreadable: string[]): Promise<number> {
  const entries = await entriesIn(join(dir, NOTES_DIR), unreadable);
  if (entries === null) return 0;
  return entries.filter((entry) => !entry.isDirectory() && entry.name.endsWith(NOTE_SUFFIX)).length;
}

/**
 * The writes a mirror has taken but not delivered: one file per entry.
 *
 * A stage file (`<entry>.json.tmp`) is a write in progress rather than an entry, so only the
 * `.json` names count. A rejected entry stays in the outbox and is counted: it still holds
 * a write the agent asked for.
 *
 * Anything that *is* named `.json` and is not a plain file is a write this read cannot count — a
 * link, dangling or not, a directory, a socket — so its path joins `unreadable` instead of being
 * skipped as if the outbox held nothing there. The entry is judged by its own type
 * (`readdir`'s, which never follows a link): following one would count whatever it points at,
 * and a dangling link would then vanish from the count entirely, which is exactly the read that
 * makes `isPrunableMirror` say yes to a mirror holding an undelivered write.
 */
async function outboxCount(dir: string, unreadable: string[]): Promise<number> {
  const outboxDir = join(dir, OUTBOX_DIR);
  const entries = await entriesIn(outboxDir, unreadable);
  if (entries === null) return 0;
  let count = 0;
  for (const entry of entries) {
    if (!entry.name.endsWith(OUTBOX_ENTRY_SUFFIX)) continue;
    if (entry.isFile()) {
      count += 1;
      continue;
    }
    unreadable.push(join(outboxDir, entry.name));
  }
  return count;
}

/**
 * Whether the mirror holds an archive.
 *
 * `lstat`, and anything that is not a plain file counts: an archive directory, and equally a
 * link at the name — dangling or not, it is a compaction's record that this read cannot
 * vouch for being empty.
 */
async function archivePresent(dir: string, unreadable: string[]): Promise<boolean> {
  const info = await lstatOrNull(join(dir, ARCHIVE_DIR), unreadable);
  return info !== null && !info.isFile();
}

/** Whether the value is an object whose fields this read may take. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The provider the mirror's sync state records, or `null` when it records none. */
async function readProvider(dir: string, unreadable: string[]): Promise<string | null> {
  const state = await jsonOrNull(join(dir, SYNC_STATE_FILE), unreadable);
  if (!isRecord(state)) return null;
  const provider = state.provider;
  return typeof provider === "string" ? provider : null;
}

/** The repository root the mirror's origin records, or `null` when it has none. */
async function readOriginRoot(dir: string, unreadable: string[]): Promise<string | null> {
  const origin = await jsonOrNull(join(dir, ORIGIN_FILE), unreadable);
  if (!isRecord(origin)) return null;
  const root = origin.root;
  // Only an absolute path is looked for: a relative one would be resolved against whatever
  // directory this process happens to run from, which says nothing about the mirror.
  return typeof root === "string" && isAbsolute(root) ? root : null;
}

/** One mirror's inventory, read from its directory alone. */
async function readMirror(dir: string, name: string): Promise<MemoryMirrorInfo> {
  const unreadable: string[] = [];
  const originRoot = await readOriginRoot(dir, unreadable);
  const [notes, outbox, provider, indexBytes, decisions, pendingForgets, inUse, hasArchive, rootExists] =
    await Promise.all([
      noteCount(dir, unreadable),
      outboxCount(dir, unreadable),
      readProvider(dir, unreadable),
      fileBytes(join(dir, INDEX_FILE), unreadable),
      lineCount(join(dir, DECISIONS_FILE), unreadable),
      lineCount(join(dir, PENDING_FORGETS_FILE), unreadable),
      present(join(dir, SYNC_LOCK_FILE), unreadable),
      archivePresent(dir, unreadable),
      originRoot === null ? null : isDirectory(originRoot),
    ]);
  return {
    dir,
    name,
    notes,
    outbox,
    provider,
    originRoot,
    rootExists,
    indexBytes,
    inUse,
    hasArchive,
    decisions,
    pendingForgets,
    unreadable,
  };
}

/**
 * List every mirror under the projects directory, in name order.
 *
 * @param projectsDir - `<globalConfigDir()>/memory/projects` (`memoryProjectsDir()`)
 */
export async function listMemoryMirrors(projectsDir: string): Promise<readonly MemoryMirrorInfo[]> {
  // The projects directory failing is the one unreadable read with no entry to mark: the
  // answer "no mirrors" prunes nothing, which is the safe direction, and a caller that wants
  // to report the failure has nothing per-mirror to report it against.
  const entries = await entriesIn(projectsDir, []);
  if (entries === null) return [];
  const mirrors = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: join(projectsDir, entry.name), name: entry.name }))
    .sort((left, right) => byCodePoint(left.name, right.name));
  return await Promise.all(mirrors.map((mirror) => readMirror(mirror.dir, mirror.name)));
}

/** Whether one path is there at all, is not there, or is there and cannot be looked at. */
type Presence = "present" | "absent" | "unreadable";

/** `lstat`'s answer about one path: absence and "will not say" are different answers. */
async function presenceOf(path: string): Promise<Presence> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    // Only a path that is not there is absent. Anything else — a permission this process does
    // not have, a mount that went away — is a mirror this read cannot vouch for.
    return isMissing(error) ? "absent" : "unreadable";
  }
}

/**
 * One mirror, read by its own directory rather than through the projects-directory listing.
 *
 * This is the read a caller takes a decision on, and the reason it does not go through
 * `listMemoryMirrors` is the listing's one fail-open: a projects directory that cannot be
 * listed answers "no mirrors", which is indistinguishable there from a mirror that is gone. A
 * caller about to delete the mirror cannot afford that reading. Naming the directory asks the
 * mirror itself, so the three answers are distinct — it is there and fully read, it is not
 * there, or it is there and this process could not read all of it — and "cannot read" is never
 * "empty".
 *
 * A mirror whose own directory cannot be stated at all answers `unreadable` for the same
 * reason: the deletion decision is exactly where an unknown must not become a yes.
 *
 * @param dir - The mirror's absolute directory (`MemoryMirrorInfo.dir`)
 */
export async function readMemoryMirror(dir: string): Promise<MemoryMirrorRead> {
  const presence = await presenceOf(dir);
  if (presence === "absent") return { kind: "absent" };
  if (presence === "unreadable") return { kind: "unreadable" };
  const mirror = await readMirror(dir, basename(dir));
  return mirror.unreadable.length === 0 ? { kind: "read", mirror } : { kind: "unreadable" };
}

/**
 * Whether a mirror can be removed without losing anything a session put there.
 *
 * Every kind of content counts, and so does the archive: a compaction's pre-change notes are
 * the only way back from it, and a rolled-back or in-progress archive is not this listing's
 * to judge. A mirror whose sync is in flight is never prunable, because this process cannot
 * tell a live lock from a stale one and removing the directory under a running sync is the
 * one failure that loses data. Neither is a mirror this read could not see all of: a count it
 * could not take is a lower bound, and "0 notes" from an unreadable `notes/` is not "empty".
 *
 * Where the mirror's repository is does not decide anything. A checkout can be gone for a
 * week and come back, and a mirror with nothing in it is still empty either way.
 */
export function isPrunableMirror(mirror: MemoryMirrorInfo): boolean {
  return (
    mirror.unreadable.length === 0 &&
    mirror.notes === 0 &&
    mirror.outbox === 0 &&
    !mirror.hasArchive &&
    mirror.decisions === 0 &&
    mirror.pendingForgets === 0 &&
    !mirror.inUse
  );
}
