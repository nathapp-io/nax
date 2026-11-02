/**
 * Whole-file writes that a crash cannot tear.
 *
 * `writeFile` truncates the target before the new bytes land, so a process
 * killed mid-write (SIGKILL, OOM, ENOSPC) leaves a partial file and the old
 * content is gone. Staging the bytes in a sibling and `rename`-ing it over the
 * target publishes the new content in one step: a reader, or the next run,
 * sees the old file or the new one. Same-directory staging keeps the rename on
 * one filesystem, where POSIX makes it atomic. Not fsync'd: this guards against
 * a killed PROCESS, not a power loss.
 *
 * The stage is created exclusively (`O_CREAT | O_EXCL`) and its identity —
 * `dev`/`ino` — is read from that descriptor, never from its path: the file this
 * call created is then known no matter what later takes the name. In a pinned-directory
 * context all stage, publication and cleanup operations are relative to its verified cwd.
 * Ordinary callers retain path-based I/O. The hooks additionally verify the destination:
 *
 * - `beforePublish` runs once the bytes are staged and before the rename, so a
 *   destination that moved during the write is refused before it receives them;
 * - `afterPublish` receives the staged file's identity once the rename is done, so a
 *   caller can check — and take back by identity — a note that landed somewhere the
 *   rename could not be told apart from;
 * - the cleanup removes the stage only while it is still the file this call created, and
 *   does the ownership check and the removal as one operation (see `removeOwnedEntry`): a
 *   stat that is then acted on would delete whatever took the name between the two.
 *
 * A throw from either hook fails the write and removes the stage.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm, unlink } from "node:fs/promises";
import { openPinnedStage, pinnedOperation } from "./pinned-directory.ts";

/** What a file is, independent of the path that names it. */
interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** Exclusive creation, and never through a link at the stage's name. */
const STAGE_FLAGS: number = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** The default a plain `writeFile` would apply, so a published note keeps ordinary permissions. */
const STAGE_MODE = 0o666;

/** One created stage: written through its descriptor, identified by it, then closed. */
interface StagedFile {
  write(content: string | Uint8Array): Promise<void>;
  identity(): Promise<Identity>;
  close(): Promise<void>;
}

/**
 * Remove the entry at `path` only while it still holds the file `created` names.
 *
 * Injectable for tests that simulate a stage name being taken over before the removal.
 */
type DiscardStage = (path: string, created: Identity) => Promise<void>;

/** Injectable for tests that simulate a write dying part-way, or a stage name being taken over. */
export const _atomicWriteDeps: {
  open: (path: string, flags: number, mode: number) => Promise<StagedFile>;
  rename: typeof rename;
  rm: typeof rm;
  discard: DiscardStage;
} = {
  open: async (path, flags, mode) => {
    const pinned = await openPinnedStage(path, flags, mode);
    if (pinned) return pinned;
    const handle = await open(path, flags, mode);
    return {
      write: (content) => handle.writeFile(content, { encoding: "utf8" }),
      identity: async () => {
        const info = await handle.stat();
        return { dev: info.dev, ino: info.ino };
      },
      close: () => handle.close(),
    };
  },
  rename: (from, to) => pinnedOperation<void>(String(from), "rename", [String(to)]) ?? rename(from, to),
  rm: (path, options) => pinnedOperation<void>(String(path), "rm") ?? rm(path, options),
  discard: (path, created) => removeOwnedEntry(path, created),
};

/**
 * The identity of whatever entry is at `path`, never following a link there.
 *
 * Deliberately not a seam: the ownership check below is only worth anything if nothing can
 * interpose between it and the removal it licenses.
 */
async function entryIdentity(path: string): Promise<Identity | null> {
  try {
    const info = await lstat(path);
    return { dev: info.dev, ino: info.ino };
  } catch {
    // Nothing there to identify — and nothing left to remove.
    return null;
  }
}

/**
 * Remove a stage's entry, but only while that entry is still the file this call created.
 *
 * Ownership of a name cannot be proven by a stat and then acted on: `lstat` and `unlink` are
 * two operations, and anything able to write in the directory can put a different file at the
 * name between them — which that sequence then deletes even though this module never wrote it.
 * So the check and the removal are one operation, and there is deliberately nothing injectable
 * inside it:
 *
 * - in a pinned directory the worker does both in a single request, so no code in this
 *   process can interpose;
 * - elsewhere they are the two statements below, with no seam between them.
 *
 * What remains is the caller's contract: whoever can write in the target's directory is the
 * trust boundary — they could replace the target itself. A replacement that lands *before* the
 * operation is caught by the check and retained, and a stray `.tmp` beside the target costs
 * nothing because every listing in this package ignores those names. A replacement that lands
 * after it is a file this call has already decided not to touch.
 */
async function removeOwnedEntry(path: string, created: Identity): Promise<void> {
  const pinned = pinnedOperation<boolean>(path, "discard", [JSON.stringify(created)]);
  if (pinned !== null) {
    await pinned;
    return;
  }
  const current = await entryIdentity(path);
  if (current === null) return;
  if (current.dev !== created.dev || current.ino !== created.ino) return;
  await unlink(path);
}

/**
 * Remove the stage this call created, or leave it in place when its ownership cannot be proven.
 *
 * `created` is the identity taken from the descriptor at creation, so it stays true even if
 * the name was taken over afterwards. A mismatch means the path now holds something else, and
 * removing it would delete data this module never wrote. Without an identity (open or fstat
 * failed), ownership is unknown: never remove an entry on that basis. A removal that fails is
 * not reported: the failure the caller is owed is the one that brought us here.
 */
async function discardStage(staged: string, created: Identity | null): Promise<void> {
  if (created === null) return;
  await _atomicWriteDeps.discard(staged, created).catch(() => {
    // A stage that could not be removed is retained; the pinned worker reports its own errors.
  });
}

export async function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  options: {
    mode?: number;
    beforePublish?: () => Promise<void>;
    afterPublish?: (stage: { dev: number; ino: number }) => Promise<void>;
  } = {},
): Promise<void> {
  // Ends in `.tmp`, not `.json`, so directory sweeps that match `*.json` never see it.
  const staged = `${path}.${randomUUID()}.tmp`;
  let stage: StagedFile | null = null;
  let identity: Identity | null = null;
  try {
    stage = await _atomicWriteDeps.open(staged, STAGE_FLAGS, options.mode ?? STAGE_MODE);
    // Capture ownership before writing: a failed write may already have lost its pathname.
    identity = await stage.identity();
    await stage.write(content);
    if (options.beforePublish) await options.beforePublish();
    await _atomicWriteDeps.rename(staged, path);
    if (options.afterPublish && identity !== null) await options.afterPublish(identity);
  } catch (error) {
    await discardStage(staged, identity);
    throw error;
  } finally {
    await stage?.close().catch(() => {
      // A stage whose write already failed cannot be rescued by reporting the close either.
    });
  }
}
