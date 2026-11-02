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
 * `beforePublish` is the caller's hook for a destination it has to re-check: it
 * runs once the bytes are staged and before the rename, so a caller confining its
 * writes can refuse a destination that moved during the write. A throw fails the
 * write and removes the stage.
 */
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** The one `writeFile` shape this module uses; narrower than the overloaded node signature so stubs type-check. */
type WriteText = (
  path: string,
  content: string | Uint8Array,
  options: { encoding: "utf8"; mode?: number },
) => Promise<void>;

/** Injectable for tests that simulate a write dying part-way. */
export const _atomicWriteDeps: { writeFile: WriteText; rename: typeof rename; rm: typeof rm } = {
  writeFile: (path, content, options) => writeFile(path, content, options),
  rename,
  rm,
};

export async function writeFileAtomic(
  path: string,
  content: string | Uint8Array,
  options: { mode?: number; beforePublish?: () => Promise<void> } = {},
): Promise<void> {
  // Ends in `.tmp`, not `.json`, so directory sweeps that match `*.json` never see it.
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await _atomicWriteDeps.writeFile(staged, content, {
      encoding: "utf8",
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    // The caller's last word on the destination, after the bytes are staged and before they
    // are published: a caller that confines where it writes re-checks here, so a destination
    // that moved during the write is refused instead of receiving the content. Throwing
    // fails the write and removes the stage, like any other failure.
    if (options.beforePublish) await options.beforePublish();
    await _atomicWriteDeps.rename(staged, path);
  } catch (error) {
    await _atomicWriteDeps.rm(staged, { force: true });
    throw error;
  }
}
