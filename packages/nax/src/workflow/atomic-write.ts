/**
 * The staged write every run-state file uses: the whole payload reaches a private sibling first, and one
 * `rename` publishes it (result.json's own "tmp + rename").
 *
 * Two things make the staging file safe. Its name carries a fresh `randomUUID`, so no other writer can
 * name it and neither can anything already sitting at a name this code would have chosen. And it is
 * created exclusively with `O_NOFOLLOW`, so an existing path — above all a symlink to a file outside the
 * workflow directory — is refused rather than written through: a predictable `<path>.tmp` let replay
 * overwrite an unrelated file and still report success. The payload is written through the handle the
 * exclusive create returned, never by path, so nothing can be swapped in between.
 */
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";

/** Write-only, create-if-absent, exclusive and link-refusing: the create cannot land on an existing path. */
const STAGING_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
/** The mode nax's own artifacts carry; the process umask still applies, as it did to `Bun.write`. */
const STAGING_MODE = 0o644;

/** The filesystem calls a staged write needs, so each caller keeps its own injectable seam. */
export interface StagedWriteDeps {
  /** Open a path (never a link) for writing, creating it exclusively. */
  open: (path: string, flags: number, mode: number) => Promise<FileHandle>;
  /** Publish the staging file at the target path. */
  rename: (from: string, to: string) => Promise<void>;
  /** Remove a staging file's own path. */
  unlink: (path: string) => Promise<void>;
}

/** A staging sibling of `path` that no other writer can have created. */
function stagingPath(path: string): string {
  return `${path}.staged-${crypto.randomUUID()}`;
}

/**
 * Write `content` to `path` through a private staging sibling, then publish it with one `rename`.
 *
 * A failed write or rename removes the staging file this call created, so a failure leaves the
 * directory as it found it. A path that already exists at the staging name was not this call's and is
 * never removed.
 *
 * @param path - The file to publish
 * @param content - The complete text
 * @param deps - The caller's filesystem seam
 */
export async function writeStagedFile(path: string, content: string, deps: StagedWriteDeps): Promise<void> {
  const staged = stagingPath(path);
  let created = false;
  try {
    const handle = await deps.open(staged, STAGING_FLAGS, STAGING_MODE);
    created = true;
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    await deps.rename(staged, path);
  } catch (error) {
    if (created) await deps.unlink(staged).catch(() => {});
    throw error;
  }
}
