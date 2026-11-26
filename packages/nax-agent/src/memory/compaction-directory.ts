/** Walk archive directories by identity: a name is inspected in its pinned parent before
 * it can become the cwd of a worker. Neither a link nor a swap during open can redirect I/O. */
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { join } from "node:path";
import { NaxError } from "#src/infra/nax-error";
import { openPinnedRead, pinnedOperation } from "#src/internal/pinned-directory";
import { MEMORY_COMPACTION_ID_RE } from "./compaction-types.ts";
import { _memoryStoreDeps, type MemoryStore } from "./store.ts";
import { ARCHIVE_DIR, NOTES_DIR } from "./store-paths.ts";

export function invalidArchive(id: string): NaxError {
  return new NaxError(`Invalid compaction archive: ${id}`, "MEMORY_COMPACT_ARCHIVE_INVALID", { stage: "memory", id });
}

export function pinned<T>(path: string, op: string, args: unknown[] = []): Promise<T> {
  const pending = pinnedOperation<T>(path, op, args);
  if (!pending) throw invalidArchive(path);
  return pending;
}

export async function archiveText(path: string): Promise<string> {
  const file = await openPinnedRead(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  if (!file) throw invalidArchive(path);
  try {
    return await file.readText();
  } finally {
    await file.close();
  }
}

type Identity = { dev: number; ino: number };
export const archiveDirectoryIdentities = new AsyncLocalStorage<Map<string, Identity>>();

export async function inArchive<T>(
  input: { store: MemoryStore; id?: string; notes?: boolean; create?: boolean; exclusive?: boolean },
  action: (dir: string) => Promise<T>,
): Promise<T> {
  if (input.id !== undefined && !MEMORY_COMPACTION_ID_RE.test(input.id)) throw invalidArchive(input.id);
  const parts = [ARCHIVE_DIR, ...(input.id === undefined ? [] : [input.id]), ...(input.notes ? [NOTES_DIR] : [])];
  return inProjectDirectory(input.store, input.create === true, async (root, identity) => visit(root, identity, 0));
  async function visit(path: string, identity: Identity, depth: number): Promise<T> {
    const known = archiveDirectoryIdentities.getStore();
    const original = known?.get(path);
    if (original && (original.ino !== identity.ino || original.dev !== identity.dev)) throw invalidArchive(path);
    known?.set(path, identity);
    return _memoryStoreDeps.pin({ path, identity, changed: () => invalidArchive(path) }, async () => {
      const part = parts[depth];
      if (part === undefined) return action(path);
      const child = join(path, part);
      if (input.create) {
        try {
          await pinned(child, "stage", [0o700]);
        } catch (error) {
          if (
            !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
            (input.exclusive && depth === 1)
          )
            throw error;
        }
      }
      return visit(child, await pinned<Identity>(child, "stat"), depth + 1);
    });
  }
}

/** Start at the project inode itself; refusing a linked root prevents redirecting a worker. */
async function inProjectDirectory<T>(
  store: MemoryStore,
  create: boolean,
  action: (dir: string, id: Identity) => Promise<T>,
): Promise<T> {
  const root = store.paths.projectDir;
  if (create) await _memoryStoreDeps.mkdir(root, { recursive: true });
  return action(root, await _memoryStoreDeps.lstat(root));
}

export function inLogDirectory<T>(store: MemoryStore, create: boolean, action: () => Promise<T>): Promise<T> {
  return inProjectDirectory(store, create, (path, identity) => {
    const known = archiveDirectoryIdentities.getStore()?.get(path);
    if (known && (known.ino !== identity.ino || known.dev !== identity.dev)) throw invalidArchive(path);
    return _memoryStoreDeps.pin({ path, identity, changed: () => invalidArchive(path) }, action);
  });
}
