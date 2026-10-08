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
 */
import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

/** The one `writeFile` shape this module uses; narrower than the overloaded node signature so stubs type-check. */
type WriteText = (path: string, content: string, options: { encoding: "utf8"; mode?: number }) => Promise<void>;

/** Injectable for tests that simulate a write dying part-way. */
export const _atomicWriteDeps: { writeFile: WriteText; rename: typeof rename; rm: typeof rm } = {
  writeFile: (path, content, options) => writeFile(path, content, options),
  rename,
  rm,
};

export async function writeFileAtomic(path: string, content: string, options: { mode?: number } = {}): Promise<void> {
  // Ends in `.tmp`, not `.json`, so directory sweeps that match `*.json` never see it.
  const staged = `${path}.${randomUUID()}.tmp`;
  try {
    await _atomicWriteDeps.writeFile(staged, content, {
      encoding: "utf8",
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    await _atomicWriteDeps.rename(staged, path);
  } catch (error) {
    await _atomicWriteDeps.rm(staged, { force: true });
    throw error;
  }
}
