/** Walk archive directories by identity: a name is inspected in its pinned parent before
 * it can become the cwd of a worker. Neither a link nor a swap during open can redirect I/O. */
import { AsyncLocalStorage } from "node:async_hooks";
import { constants } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "#src/infra/nax-error";
import { openPinnedRead, pinnedOperation, withPinnedDirectory } from "#src/internal/pinned-directory";
import { MEMORY_COMPACTION_ID_RE } from "./compaction-types.ts";
import type { MemoryStore } from "./store.ts";
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
  const root = input.store.paths.projectDir;
  if (input.create) await mkdir(root, { recursive: true });
  const parts = [ARCHIVE_DIR, ...(input.id === undefined ? [] : [input.id]), ...(input.notes ? [NOTES_DIR] : [])];
  async function visit(path: string, identity: Identity, depth: number): Promise<T> {
    const known = archiveDirectoryIdentities.getStore();
    const original = known?.get(path);
    if (original && (original.ino !== identity.ino || original.dev !== identity.dev)) throw invalidArchive(path);
    known?.set(path, identity);
    return withPinnedDirectory({ path, identity, changed: () => invalidArchive(path) }, async () => {
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
  return visit(root, await lstat(root), 0);
}
