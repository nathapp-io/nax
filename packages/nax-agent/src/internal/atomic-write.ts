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
 * The stage is a *directory* (`<path>.<uuid>.tmp`) created exclusively by this
 * call. Exclusive creation and mode 0700 do not establish continuing ownership:
 * a writer of its parent can rename it and put a foreign directory or link at
 * its name. Cleanup therefore NEVER unlinks a payload through that pathname.
 * It only attempts `rmdir`, which neither follows a final symlink nor removes a
 * nonempty directory. Failed writes conservatively retain their payloads; even
 * a replacement between the last check and cleanup cannot lose foreign bytes.
 * Successful publication normally leaves an empty stage directory to remove.
 * A retained `.tmp` namespace is ignored by the package's listings. No pathname
 * identity check is claimed to make cleanup ownership-atomic.
 *
 * In a pinned-directory context all stage, publication and cleanup operations
 * are relative to the verified cwd, and the stage directory is reached as one
 * deeper operand of it. Ordinary callers retain path-based I/O. The hooks
 * additionally verify the destination:
 *
 * - `beforePublish` runs once the bytes are staged and before the rename, so a
 *   destination that moved during the write is refused before it receives them;
 * - `afterPublish` receives the staged file's identity once the rename is done, so a
 *   caller can check — and take back by identity — a note that landed somewhere the
 *   rename could not be told apart from.
 *
 * A throw from either hook fails the write; cleanup retains any remaining payload.
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { openPinnedStage, pinnedOperation } from "./pinned-directory.ts";

/** What a file is, independent of the path that names it. */
interface Identity {
  readonly dev: number;
  readonly ino: number;
}

/** Exclusive creation, and never through a link at the stage's name. */
const STAGE_FLAGS: number = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/** Restrict access inside the stage, without claiming that its parent cannot replace it. */
const STAGE_DIR_MODE = 0o700;

/** The default a plain `writeFile` would apply, so a published note keeps ordinary permissions. */
const STAGE_MODE = 0o666;

/** The suffix every stage directory carries; the package's listings ignore those names. */
const STAGE_SUFFIX = ".tmp";

/** The payload's name inside the stage directory: the only entry this call ever puts there. */
const STAGE_NAME = "stage";

/** One created stage: written through its descriptor, identified by it, then closed. */
interface StagedFile {
  write(content: string | Uint8Array): Promise<void>;
  identity(): Promise<Identity>;
  close(): Promise<void>;
}

/** Try removing an empty stage directory, never its contents. Injectable for tests. */
type DiscardStage = (stageDir: string) => Promise<void>;

/** Injectable for tests that simulate a write dying part-way, or a stage namespace being taken. */
export const _atomicWriteDeps: {
  stage: (dir: string, mode: number) => Promise<void>;
  open: (path: string, flags: number, mode: number) => Promise<StagedFile>;
  rename: typeof rename;
  rm: typeof rm;
  discard: DiscardStage;
} = {
  stage: async (dir, mode) => {
    const pinned = await pinnedOperation<void>(dir, "stage", [mode]);
    if (pinned !== null) return await pinned;
    await mkdir(dir, { mode });
  },
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
  discard: (dir) => removeStage(dir),
};

/** Remove only an empty namespace; a payload's ownership cannot be proved by its pathname. */
async function removeStage(stageDir: string): Promise<void> {
  const pinned = pinnedOperation<void>(stageDir, "discard");
  if (pinned !== null) return await pinned;
  await rmdir(stageDir);
}

/**
 * Remove the stage this call created, or leave it in place when it cannot be emptied.
 *
 * A removal that fails is not reported: the failure the caller is owed is the one that
 * brought us here, and a stage left behind is a name every listing in the package ignores.
 */
async function discardStage(stageDir: string, owned: boolean): Promise<void> {
  if (!owned) return;
  await _atomicWriteDeps.discard(stageDir).catch(() => {
    // A stage that could not be emptied is retained; the pinned worker reports its own errors.
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
  const staged = `${path}.${randomUUID()}${STAGE_SUFFIX}`;
  const payload = join(staged, STAGE_NAME);
  let stage: StagedFile | null = null;
  let owned = false;
  let identity: Identity | null = null;
  try {
    await _atomicWriteDeps.stage(staged, STAGE_DIR_MODE);
    // Only a namespace this call created is this call's to remove.
    owned = true;
    stage = await _atomicWriteDeps.open(payload, STAGE_FLAGS, options.mode ?? STAGE_MODE);
    // Capture ownership before writing: a failed write may already have lost its pathname.
    identity = await stage.identity();
    await stage.write(content);
    if (options.beforePublish) await options.beforePublish();
    await _atomicWriteDeps.rename(payload, path);
    if (options.afterPublish && identity !== null) await options.afterPublish(identity);
  } catch (error) {
    await discardStage(staged, owned);
    throw error;
  } finally {
    await stage?.close().catch(() => {
      // A stage whose write already failed cannot be rescued by reporting the close either.
    });
  }
  // The published payload left the namespace empty: the directory is all that remains.
  await discardStage(staged, owned);
}
