/**
 * The persistent per-folder trust store: `<globalConfigDir>/trust.json` (US-001).
 *
 * The store is global and operator-owned; `NAX_GLOBAL_CONFIG_DIR` relocates it
 * for tests. Every read-modify-write runs under `withPathFileLock`, so two
 * concurrent adds cannot drop one another's entry, and every write goes
 * through a sibling temp file renamed over the target so a reader never sees a
 * half-written document.
 *
 * Two properties a naive implementation gets wrong, both fail-closed:
 *
 *  - `addTrustEntry` must `mkdir` the global config directory BEFORE taking the
 *    lock: the lock is created with the `wx` flag (`src/utils/file-lock.ts`),
 *    which cannot create its parent, so a first-ever run with no `~/.nax` would
 *    otherwise fail ENOENT (AC15).
 *  - An unparseable store makes both writes fail with `TRUST_STORE_UNREADABLE`
 *    instead of silently starting from an empty store, which would discard
 *    entries, or from a forged one (AC17, AC21). The bytes on disk are left
 *    untouched.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
// Leaf import, not the @/config barrel — see match.ts.
import { globalConfigDir } from "@/config/paths";
import { NaxError } from "@/errors";
import { errorMessage } from "@/utils/errors";
import { withPathFileLock } from "@/utils/path-file-lock";
import { findCoveringEntry, normalizeTrustPath } from "./match";
import type { AddTrustResult, RemoveTrustResult, TrustEntry, TrustStoreFile, TrustStoreRead } from "./types";

/** Injectable clock; the only ambient input a write has besides the path. */
export const _trustStoreDeps: { now: () => Date } = {
  now: () => new Date(),
};

/**
 * The on-disk shape. A `path` must be absolute and a `via` must be one of the
 * two sources; anything else -- including another `version` -- is a document
 * this build cannot trust, and `readTrustStore` reports it as unparseable
 * rather than guessing at it.
 */
export const TrustStoreFileSchema = z.object({
  version: z.literal(1),
  folders: z.array(
    z.object({
      path: z.string().refine((path) => isAbsolute(path), { message: "path must be absolute" }),
      addedAt: z.string(),
      via: z.enum(["prompt", "cli"]),
    }),
  ),
});

/** Absolute path of the trust store: `<globalConfigDir()>/trust.json`. */
export function trustStorePath(): string {
  return join(globalConfigDir(), "trust.json");
}

/**
 * The single producer of `TRUST_STORE_UNREADABLE` — a store present on disk
 * but not readable as the version-1 shape.
 *
 * Shared by the two readers that must fail closed on such a file
 * (`readFoldersForWrite` here, `ensureProjectTrusted` in `gate.ts`) and by the
 * CLI surfaces that report it (`nax trust add|rm|check`), so the message an
 * operator sees is the same whichever path refused.
 */
export function trustStoreUnreadableError(storePath: string, reason: string): NaxError {
  return new NaxError(`[trust] trust store at ${storePath} could not be parsed: ${reason}`, "TRUST_STORE_UNREADABLE", {
    stage: "trust",
    path: storePath,
    reason,
  });
}

/**
 * Classify the store. `missing` is the whole path resolving to no file (a
 * missing global config directory included); `unparseable` is a file present
 * but not readable as the version-1 shape; `ok` carries the parsed document.
 */
export async function readTrustStore(): Promise<TrustStoreRead> {
  const path = trustStorePath();
  const file = Bun.file(path);
  let contents: string;
  try {
    if (!(await file.exists())) return { state: "missing" };
    contents = await file.text();
  } catch (err) {
    // A read failure is not "no store": fail closed, the same as a malformed one.
    return { state: "unparseable", reason: errorMessage(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    return { state: "unparseable", reason: errorMessage(err) };
  }
  const result = TrustStoreFileSchema.safeParse(parsed);
  if (!result.success) return { state: "unparseable", reason: result.error.message };
  return { state: "ok", file: result.data };
}

/**
 * Trust `path` (normalized) unless an existing entry already covers it. An
 * existing entry wins without a write, and descendant entries are kept --
 * removing them would revoke trust the operator granted separately.
 */
export async function addTrustEntry(path: string, via: TrustEntry["via"]): Promise<AddTrustResult> {
  const normalized = await normalizeTrustPath(path);
  const storePath = trustStorePath();
  await mkdir(dirname(storePath), { recursive: true });
  return withPathFileLock(storePath, async () => {
    const folders = await readFoldersForWrite(storePath);
    const coveredBy = findCoveringEntry(folders, normalized);
    if (coveredBy !== null) return { outcome: "already-covered", coveredBy };
    const entry: TrustEntry = { path: normalized, addedAt: _trustStoreDeps.now().toISOString(), via };
    await writeTrustStore(storePath, { version: 1, folders: [...folders, entry] });
    return { outcome: "added", entry };
  });
}

/**
 * Remove the entry whose `path` equals `path` (normalized). Only an exact
 * entry is removed -- a descendant is reported `not-found` with the covering
 * entry and nothing is written, because removing the ancestor instead would
 * revoke trust the operator did not name.
 *
 * With no global config directory there is no store, so the lock is skipped:
 * the lock file lives beside the target and creating it would mean creating
 * the directory this operation must not create (AC22).
 */
export async function removeTrustEntry(path: string): Promise<RemoveTrustResult> {
  const normalized = await normalizeTrustPath(path);
  const storePath = trustStorePath();
  if (!(await directoryExists(dirname(storePath)))) return removeFromStore(storePath, normalized);
  return withPathFileLock(storePath, () => removeFromStore(storePath, normalized));
}

/** Locked body of `removeTrustEntry`: read, drop an exact entry, write. */
async function removeFromStore(storePath: string, normalized: string): Promise<RemoveTrustResult> {
  const folders = await readFoldersForWrite(storePath);
  const index = folders.findIndex((folder) => folder.path === normalized);
  if (index === -1) return { outcome: "not-found", coveredBy: findCoveringEntry(folders, normalized) };
  const entry = folders[index];
  await writeTrustStore(storePath, { version: 1, folders: folders.filter((_, i) => i !== index) });
  return { outcome: "removed", entry };
}

/**
 * The entries a write should build on. A missing store is an empty one; an
 * unparseable store is an error, never an empty one -- rewriting it would
 * destroy whatever it holds.
 */
async function readFoldersForWrite(storePath: string): Promise<TrustEntry[]> {
  const read = await readTrustStore();
  if (read.state === "unparseable") {
    throw trustStoreUnreadableError(storePath, read.reason);
  }
  return read.state === "ok" ? read.file.folders : [];
}

/**
 * Serialize the store atomically: a sibling temp file written 0o600, renamed
 * over the target. `Bun.write` takes no mode, so the document is written
 * through `node:fs/promises` (`writeFile`) -- the same seam `approvals-store`
 * uses -- because the store is a credential-adjacent file the operator, not
 * the group or the world, must own.
 */
async function writeTrustStore(storePath: string, file: TrustStoreFile): Promise<void> {
  const tempPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, storePath);
  } finally {
    // Cleanup must not replace the original write/rename failure.
    await unlink(tempPath).catch(() => {});
  }
}

/** `true` iff `dir` exists and is a directory. Anything else means "no store". */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
