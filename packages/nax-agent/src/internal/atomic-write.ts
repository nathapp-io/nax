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
 * - the cleanup is identity-checked: the stage is removed only while the path still
 *   holds the file this call created, never whatever took its name.
 *
 * A throw from either hook fails the write and removes the stage.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
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

type StatPath = (path: string) => Promise<Identity>;

/** Injectable for tests that simulate a write dying part-way, or a stage name being taken over. */
export const _atomicWriteDeps: {
  open: (path: string, flags: number, mode: number) => Promise<StagedFile>;
  rename: typeof rename;
  rm: typeof rm;
  stat: StatPath;
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
  stat: async (path) => {
    const info = await (pinnedOperation<Identity>(path, "stat") ?? stat(path));
    return { dev: info.dev, ino: info.ino };
  },
};

/** The identity of whatever is at `path`, or `null` when nothing is. */
async function identityAt(path: string): Promise<Identity | null> {
  try {
    return await _atomicWriteDeps.stat(path);
  } catch {
    // Nothing there to identify — and nothing left to remove.
    return null;
  }
}

/**
 * Remove the stage, but only while the path still holds the file this call created.
 *
 * `created` is the identity taken from the descriptor at creation, so it stays true even if
 * the name was taken over afterwards. A mismatch means the path now holds something else,
 * and removing it would delete data this module never wrote. Without an identity (open
 * or fstat failed), ownership is unknown: never remove an entry on that basis.
 */
async function discardStage(staged: string, created: Identity | null): Promise<void> {
  if (created === null) return;
  const current = await identityAt(staged);
  if (current === null) return;
  if (current.dev !== created.dev || current.ino !== created.ino) return;
  await _atomicWriteDeps.rm(staged, { force: true });
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
