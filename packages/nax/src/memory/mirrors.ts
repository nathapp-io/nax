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
 * Nothing here writes, locks or repairs. Two rules follow from that. A read that fails is
 * the empty answer, never a throw: a directory another process is creating, moving or
 * removing is not an inventory failure, and the listing is a snapshot rather than a
 * guarantee. And the lock is reported rather than taken — `sync.lock` existing means a sync
 * is in flight (or died holding it) and this process cannot tell which, so a mirror that
 * looks empty but is locked is never called prunable. A stale lock costs a listing line; a
 * prune under a live sync would cost the mirror.
 *
 * The file names are spelled here rather than imported: `packages/nax-agent/src/memory/
 * store-paths.ts` owns the layout for the code that reads and writes a mirror, and it
 * publishes no constant through the package entry. Keep the two in step.
 */
import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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
  /** Whether it holds a `archive/` directory, from any compaction, applied or rolled back. */
  readonly hasArchive: boolean;
  /** How many decisions its `decisions.jsonl` holds. */
  readonly decisions: number;
  /** How many forgets its `pending-forgets.jsonl` still holds. */
  readonly pendingForgets: number;
}

/** One directory's entries, or `null` when it is absent or cannot be read. */
async function entriesIn(dir: string): Promise<readonly Dirent[] | null> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    // Absent and unreadable read the same here: nothing is known to be in there.
    return null;
  }
}

/** One file's text, or `null` when it is absent or cannot be read. */
async function textOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // A record a mirror does not hold (yet) is not a failure to report.
    return null;
  }
}

/** The JSON one file holds, or `null` when it is absent or is not JSON. */
async function jsonOrNull(path: string): Promise<unknown> {
  const text = await textOrNull(path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    // A record this file cannot hold is read as an absent one: a listing never refuses.
    return null;
  }
}

/** One `stat` of a path, or `null` when it is absent or cannot be read. */
async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    // Absent is the ordinary answer here: most of what a mirror may hold, it does not.
    return null;
  }
}

/** Whether the path names a directory that is there. */
async function isDirectory(path: string): Promise<boolean> {
  return (await statOrNull(path))?.isDirectory() ?? false;
}

/** Whether anything at all sits at the path — a lock may be a file or a directory. */
async function exists(path: string): Promise<boolean> {
  return (await statOrNull(path)) !== null;
}

/** The file's byte size, or 0 when it is absent. */
async function fileBytes(path: string): Promise<number> {
  return (await statOrNull(path))?.size ?? 0;
}

/** How many records a JSONL file holds: its non-blank lines, one record each. */
async function lineCount(path: string): Promise<number> {
  const text = await textOrNull(path);
  if (text === null) return 0;
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/** The notes a mirror holds: one file per slug, both scopes counted. */
async function noteCount(dir: string): Promise<number> {
  const entries = await entriesIn(join(dir, NOTES_DIR));
  if (entries === null) return 0;
  return entries.filter((entry) => !entry.isDirectory() && entry.name.endsWith(NOTE_SUFFIX)).length;
}

/**
 * The writes a mirror has taken but not delivered: one file per entry.
 *
 * A stage file (`<entry>.json.tmp`) is a write in progress rather than an entry, so only the
 * `.json` names count. A rejected entry stays in the outbox and is counted: it still holds
 * a write the agent asked for.
 */
async function outboxCount(dir: string): Promise<number> {
  const entries = await entriesIn(join(dir, OUTBOX_DIR));
  if (entries === null) return 0;
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
}

/** Whether the value is an object whose fields this read may take. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The provider the mirror's sync state records, or `null` when it records none. */
async function readProvider(dir: string): Promise<string | null> {
  const state = await jsonOrNull(join(dir, SYNC_STATE_FILE));
  if (!isRecord(state)) return null;
  const provider = state.provider;
  return typeof provider === "string" ? provider : null;
}

/** The repository root the mirror's origin records, or `null` when it has none. */
async function readOriginRoot(dir: string): Promise<string | null> {
  const origin = await jsonOrNull(join(dir, ORIGIN_FILE));
  if (!isRecord(origin)) return null;
  const root = origin.root;
  // Only an absolute path is looked for: a relative one would be resolved against whatever
  // directory this process happens to run from, which says nothing about the mirror.
  return typeof root === "string" && isAbsolute(root) ? root : null;
}

/** One mirror's inventory, read from its directory alone. */
async function readMirror(dir: string, name: string): Promise<MemoryMirrorInfo> {
  const originRoot = await readOriginRoot(dir);
  const [notes, outbox, provider, indexBytes, decisions, pendingForgets, inUse, hasArchive, rootExists] =
    await Promise.all([
      noteCount(dir),
      outboxCount(dir),
      readProvider(dir),
      fileBytes(join(dir, INDEX_FILE)),
      lineCount(join(dir, DECISIONS_FILE)),
      lineCount(join(dir, PENDING_FORGETS_FILE)),
      exists(join(dir, SYNC_LOCK_FILE)),
      isDirectory(join(dir, ARCHIVE_DIR)),
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
  };
}

/**
 * List every mirror under the projects directory, in name order.
 *
 * @param projectsDir - `<globalConfigDir()>/memory/projects` (`memoryProjectsDir()`)
 */
export async function listMemoryMirrors(projectsDir: string): Promise<readonly MemoryMirrorInfo[]> {
  const entries = await entriesIn(projectsDir);
  if (entries === null) return [];
  const mirrors = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ dir: join(projectsDir, entry.name), name: entry.name }))
    .sort((left, right) => byCodePoint(left.name, right.name));
  return await Promise.all(mirrors.map((mirror) => readMirror(mirror.dir, mirror.name)));
}

/**
 * Whether a mirror can be removed without losing anything a session put there.
 *
 * Every kind of content counts, and so does the archive: a compaction's pre-change notes are
 * the only way back from it, and a rolled-back or in-progress archive is not this listing's
 * to judge. A mirror whose sync is in flight is never prunable, because this process cannot
 * tell a live lock from a stale one and removing the directory under a running sync is the
 * one failure that loses data.
 *
 * Where the mirror's repository is does not decide anything. A checkout can be gone for a
 * week and come back, and a mirror with nothing in it is still empty either way.
 */
export function isPrunableMirror(mirror: MemoryMirrorInfo): boolean {
  return (
    mirror.notes === 0 &&
    mirror.outbox === 0 &&
    !mirror.hasArchive &&
    mirror.decisions === 0 &&
    mirror.pendingForgets === 0 &&
    !mirror.inUse
  );
}
