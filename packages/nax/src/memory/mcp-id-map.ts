/**
 * mcp-id-map.ts — the remote ids each save produced, kept for a later forget.
 *
 * A forget request carries only a slug, and under `direct` the note is already
 * gone from the mirror when the provider is asked. So the MCP provider records,
 * per scope and slug, the ids the memory server answered a save with.
 *
 * One file per scope — `<projectDir>/mcp-ids.json` and `<userDir>/mcp-ids.json`:
 *
 *   { "version": 1, "server": "openmemory", "notes": { "replay-budget": ["a1b2"] } }
 *
 * A file that is missing, unreadable, not JSON, of another version or written
 * for another server reads as empty; the next `add` or `drop` rewrites it for
 * the configured server. Writes go to a temporary file in the same directory and
 * are renamed into place, so a reader sees the old file or the new one.
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
  /** The remote ids recorded for a note; `[]` when none (or the file is unusable). */
  ids(scope: MemoryScope, slug: string): Promise<readonly string[]>;
  /** Record ids for a note, keeping any already recorded. */
  add(scope: MemoryScope, slug: string, ids: readonly string[]): Promise<void>;
  /** Forget everything recorded for a note. */
  drop(scope: MemoryScope, slug: string): Promise<void>;
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

/** What a read found: usable notes, no file at all, or a file that cannot be used. */
interface NotesRead {
  readonly notes: Notes;
  readonly state: "valid" | "missing" | "unusable";
}

async function readNotes(path: string, server: string): Promise<NotesRead> {
  let text: string;
  try {
    text = await _mcpIdMapDeps.readText(path);
  } catch (cause) {
    const missing = (cause as { code?: unknown } | null)?.code === "ENOENT";
    return { notes: new Map(), state: missing ? "missing" : "unusable" };
  }
  try {
    const notes = notesOf(JSON.parse(text), server);
    return notes === null ? { notes: new Map(), state: "unusable" } : { notes, state: "valid" };
  } catch {
    // Not JSON: reads as an empty record, rewritten by the next add or drop.
    return { notes: new Map(), state: "unusable" };
  }
}

async function writeNotes(path: string, server: string, notes: Notes): Promise<void> {
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  const text = `${JSON.stringify({ version: MCP_ID_MAP_VERSION, server, notes: Object.fromEntries(notes) }, null, 2)}\n`;
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
    add(scope, slug, ids) {
      return serialised(async () => {
        const path = pathOf(scope);
        const { notes } = await readNotes(path, server);
        const merged = [...new Set([...(notes.get(slug) ?? []), ...ids])];
        await writeNotes(path, server, new Map(notes).set(slug, merged));
      });
    },
    drop(scope, slug) {
      return serialised(async () => {
        const path = pathOf(scope);
        const { notes, state } = await readNotes(path, server);
        // Nothing to forget in a missing file or a usable one without the slug; an unusable file is rewritten.
        if (state === "missing" || (state === "valid" && !notes.has(slug))) return;
        const rest = new Map(notes);
        rest.delete(slug);
        await writeNotes(path, server, rest);
      });
    },
  };
}
