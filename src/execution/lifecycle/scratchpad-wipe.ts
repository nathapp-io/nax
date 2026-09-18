/**
 * Run-start scratchpad wipe (US-004).
 *
 * The scratchpad tools (src/tools/scratchpad.ts) promise throwaway storage:
 * "It is never committed and is wiped at the start of each run." This is the
 * wipe — a note, a list of files to revisit, or a chunk of command output an
 * agent parks in one run must not outlive it.
 *
 * Failure is tolerated by design: a scratch directory must never wedge a run.
 * Absence is already a success (`rm` with `force: true` does not raise on a
 * missing path), and everything else — a permission error, a busy handle — is
 * logged at warn and swallowed, so the run continues either way.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { getSafeLogger } from "@/logger";
import { SCRATCHPAD_DIR } from "@/tools";
import { errorMessage } from "@/utils/errors";

/** Injectable deps for the wipe (see docs/architecture/conventions.md §2). */
export const _scratchpadWipeDeps = {
  remove: (path: string): Promise<void> => rm(path, { recursive: true, force: true }),
};

/**
 * Delete the run's scratchpad directory, tolerating absence and failure.
 *
 * Resolves for every outcome: the caller has no decision to make either way —
 * a failed wipe is reported and the run carries on.
 */
export async function wipeScratchpad(workdir: string): Promise<void> {
  const scratchpad = join(workdir, SCRATCHPAD_DIR);
  try {
    await _scratchpadWipeDeps.remove(scratchpad);
  } catch (err) {
    getSafeLogger()?.warn("setup", `Failed to wipe scratchpad ${SCRATCHPAD_DIR} — continuing with stale contents`, {
      storyId: "_setup",
      scratchpad: SCRATCHPAD_DIR,
      path: scratchpad,
      error: errorMessage(err),
    });
  }
}
