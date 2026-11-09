/**
 * mcp-id-map.ts — the remote ids each save produced, kept for a later forget,
 * and the remote ids nax hid because the server could not delete them.
 *
 * A forget request carries only a slug, and under `direct` the note is already
 * gone from the mirror when the provider is asked. So the MCP provider records,
 * per scope and slug, the ids the memory server answered a save with.
 *
 * One file per scope — `<projectDir>/mcp-ids.json` and `<userDir>/mcp-ids.json`:
 *
 *   { "version": 1, "server": "openmemory", "notes": { "replay-budget": ["a1b2"] } }
 *
 * A server with no delete tool cannot delete a copy it still holds. Such a copy
 * is hidden instead: its id moves to the file's optional `hidden` list, and nax's
 * own search drops every item whose id is hidden. The list is written only when
 * it holds something, so a file with nothing hidden is what it always was.
 *
 *   { "version": 1, "server": "openmemory", "notes": {}, "hidden": ["a1b2"] }
 *
 * A file that is missing reads as empty. A file that is not JSON, of another
 * version or written for another server also reads as empty, and the next `add`
 * or `drop` rewrites it for the configured server. A read that fails for any
 * other reason — a permission error, an I/O error, a directory at the path — is
 * not an empty file: the operation refuses with `MEMORY_MCP_ID_MAP_READ_FAILED`
 * and writes nothing, because a file nax could not read may hold ids a write
 * would drop. Writes go to a temporary file in the same directory and are
 * renamed into place, so a reader sees the old file or the new one.
 *
 * Not recovered (documented limits): ids lost between the add call and the
 * write, and two processes writing one user-scope file at the same time.
 *
 * Internal to `src/memory/`: not exported from the barrel.
 */

import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryScope } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import type { MemoryDirs } from "./paths";

/** The id-map file name inside a scope's mirror directory. */
const MCP_ID_MAP_FILE = "mcp-ids.json";
/** The only file version this module reads or writes. */
const MCP_ID_MAP_VERSION = 1;

/** The per-scope record of remote ids, keyed by note slug. */
export interface McpIdMap {
  /**
   * The remote ids recorded for a note; `[]` when none (or the file is unusable).
   *
   * A read that failed for any reason but "the file is not there" rejects with
   * `MEMORY_MCP_ID_MAP_READ_FAILED`.
   */
  ids(scope: MemoryScope, slug: string): Promise<readonly string[]>;
  /**
   * Record ids for a note, keeping any already recorded.
   *
   * A read that failed for any reason but "the file is not there" rejects with
   * `MEMORY_MCP_ID_MAP_READ_FAILED` and records nothing.
   */
  add(scope: MemoryScope, slug: string, ids: readonly string[]): Promise<void>;
  /**
   * Forget what is recorded for a note: everything, or — when `only` is given — just those ids,
   * so ids a later save recorded in the meantime survive.
   *
   * A read that failed for any reason but "the file is not there" rejects with
   * `MEMORY_MCP_ID_MAP_READ_FAILED` and forgets nothing.
   */
  drop(scope: MemoryScope, slug: string, only?: readonly string[]): Promise<void>;
  /**
   * Hide the remote ids recorded for a note: the server still holds the copies, so
   * nax's own search must not return them.
   *
   * Resolves the ids it hid. A missing file, a file whose content is not usable and
   * a slug with no recorded ids resolve `[]` and write nothing.
   *
   * A read that failed for any reason but "the file is not there" rejects with
   * `MEMORY_MCP_ID_MAP_READ_FAILED` and hides nothing.
   */
  hide(scope: MemoryScope, slug: string): Promise<readonly string[]>;
  /**
   * The remote ids nax has hidden in a scope.
   *
   * A read that failed for any reason but "the file is not there" rejects with
   * `MEMORY_MCP_ID_MAP_READ_FAILED`.
   */
  hiddenIds(scope: MemoryScope): Promise<ReadonlySet<string>>;
}

/** Filesystem seam for tests. */
export const _mcpIdMapDeps = {
  readText: (path: string): Promise<string> => Bun.file(path).text(),
  writeText: async (path: string, text: string): Promise<void> => {
    await Bun.write(path, text);
  },
  rename: (from: string, to: string): Promise<void> => rename(from, to),
  unlink: (path: string): Promise<void> => unlink(path),
};

/** A Map, not an object: a slug such as `constructor` or `__proto__` must not reach an inherited member or setter. */
type Notes = ReadonlyMap<string, readonly string[]>;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** The notes of a parsed file, or `null` when the file is not a usable version-1 file for `server`. */
function notesOf(parsed: unknown, server: string): Notes | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const file = parsed as { version?: unknown; server?: unknown; notes?: unknown };
  if (file.version !== MCP_ID_MAP_VERSION || file.server !== server) return null;
  if (typeof file.notes !== "object" || file.notes === null || Array.isArray(file.notes)) return null;
  const notes = new Map<string, readonly string[]>();
  for (const [slug, ids] of Object.entries(file.notes)) {
    if (isStringArray(ids)) notes.set(slug, ids);
  }
  return notes;
}

/**
 * The hidden ids of a parsed file, or `[]` when there are none.
 *
 * The list belongs to the file's server and version: a file written for another
 * server holds ids of that server's copies, which say nothing about this one. A
 * `hidden` value that is not an array of strings reads as no hidden ids and
 * leaves the file usable.
 */
function hiddenOf(parsed: unknown, server: string): readonly string[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const file = parsed as { version?: unknown; server?: unknown; hidden?: unknown };
  if (file.version !== MCP_ID_MAP_VERSION || file.server !== server) return [];
  return isStringArray(file.hidden) ? file.hidden : [];
}

/** What a read found: usable notes, no file at all, or a file that cannot be used. */
interface NotesRead {
  readonly notes: Notes;
  readonly hidden: readonly string[];
  readonly state: "valid" | "missing" | "unusable";
}

async function readNotes(path: string, server: string): Promise<NotesRead> {
  let text: string;
  try {
    text = await _mcpIdMapDeps.readText(path);
  } catch (cause) {
    if ((cause as { code?: unknown } | null)?.code === "ENOENT") {
      return { notes: new Map(), hidden: [], state: "missing" };
    }
    // A read that failed is not an empty file: writing over it would drop every id it holds.
    throw new NaxError(
      `[memory] cannot read MCP id map ${path}: ${errorMessage(cause)}`,
      "MEMORY_MCP_ID_MAP_READ_FAILED",
      { stage: "memory", path, retryable: true, cause },
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const notes = notesOf(parsed, server);
    if (notes === null) return { notes: new Map(), hidden: hiddenOf(parsed, server), state: "unusable" };
    return { notes, hidden: hiddenOf(parsed, server), state: "valid" };
  } catch {
    // Not JSON: reads as an empty record, rewritten by the next add or drop.
    return { notes: new Map(), hidden: [], state: "unusable" };
  }
}

async function writeNotes(path: string, server: string, notes: Notes, hidden: readonly string[] = []): Promise<void> {
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  // The `hidden` key is written only when it holds something, so a file with nothing
  // hidden is byte for byte the file this module always wrote.
  const file: { version: number; server: string; notes: Record<string, readonly string[]>; hidden?: string[] } = {
    version: MCP_ID_MAP_VERSION,
    server,
    notes: Object.fromEntries(notes),
  };
  if (hidden.length > 0) file.hidden = [...hidden];
  const text = `${JSON.stringify(file, null, 2)}\n`;
  try {
    await _mcpIdMapDeps.writeText(tmpPath, text);
    await _mcpIdMapDeps.rename(tmpPath, path);
  } catch (cause) {
    await _mcpIdMapDeps.unlink(tmpPath).catch(() => {});
    throw new NaxError(
      `[memory] cannot write MCP id map ${path}: ${errorMessage(cause)}`,
      "MEMORY_MCP_ID_MAP_WRITE_FAILED",
      { stage: "memory", path, cause },
    );
  }
}

/**
 * Create the id map for one memory server over a project's mirror directories.
 *
 * Read-modify-write sequences of one map are serialised, so concurrent `add`
 * calls on it lose no ids.
 *
 * @param input.dirs - The host's memory mirror directories
 * @param input.server - The configured memory server id; a file written for another server reads as empty
 */
export function createMcpIdMap(input: { readonly dirs: MemoryDirs; readonly server: string }): McpIdMap {
  const { dirs, server } = input;
  const pathOf = (scope: MemoryScope): string =>
    join(scope === "project" ? dirs.projectDir : dirs.userDir, MCP_ID_MAP_FILE);
  let queue: Promise<unknown> = Promise.resolve();

  /** Run `task` after every earlier mutation of this map has settled, whether it failed or not. */
  function serialised<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  }

  return {
    async ids(scope, slug) {
      await queue;
      return (await readNotes(pathOf(scope), server)).notes.get(slug) ?? [];
    },
    async hiddenIds(scope) {
      await queue;
      return new Set((await readNotes(pathOf(scope), server)).hidden);
    },
    add(scope, slug, ids) {
      return serialised(async () => {
        const path = pathOf(scope);
        const { notes, hidden } = await readNotes(path, server);
        const merged = [...new Set([...(notes.get(slug) ?? []), ...ids])];
        // A server that answers a save with a hidden id has made that copy live again.
        const kept = hidden.filter((id) => !ids.includes(id));
        await writeNotes(path, server, new Map(notes).set(slug, merged), kept);
      });
    },
    drop(scope, slug, only) {
      return serialised(async () => {
        const path = pathOf(scope);
        const { notes, hidden, state } = await readNotes(path, server);
        // Nothing to forget in a missing file or a usable one without the slug; an unusable file is rewritten.
        if (state === "missing" || (state === "valid" && !notes.has(slug))) return;
        const rest = new Map(notes);
        const kept = only === undefined ? [] : (notes.get(slug) ?? []).filter((id) => !only.includes(id));
        if (kept.length > 0) rest.set(slug, kept);
        else rest.delete(slug);
        await writeNotes(path, server, rest, hidden);
      });
    },
    hide(scope, slug) {
      return serialised(async () => {
        const path = pathOf(scope);
        const { notes, hidden, state } = await readNotes(path, server);
        // A missing file, a file whose content is not usable and a slug with no recorded
        // ids hold nothing to hide, and nothing is written for them.
        if (state !== "valid") return [];
        const recorded = notes.get(slug) ?? [];
        if (recorded.length === 0) return [];
        const rest = new Map(notes);
        rest.delete(slug);
        await writeNotes(path, server, rest, [...new Set([...hidden, ...recorded])]);
        return recorded;
      });
    },
  };
}
