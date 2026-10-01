/**
 * Run-start scratchpad wipe (US-004).
 *
 * The scratchpad tools (src/tools/scratchpad.ts) promise throwaway storage:
 * "It is never committed and is wiped when a run finishes (a failed run's
 * scratchpad is retained for inspection until the next run starts and clears
 * it)." This is the start half of that contract — the backstop that clears the
 * scratchpad however the previous run died, including the SIGKILL / hard crash
 * / power loss cases that never reach the end-of-run wipe in `cleanupRun`
 * (a `finally` block). A note, a list of files to revisit, or a chunk of
 * command output an agent parks in one run must not outlive it.
 *
 * A dry run is a preview, not a mutation, so it is skipped outright — the same
 * contract the sibling retention sweep honours (transcript-sweep.ts), and the
 * reason `runner-execution.ts` skips its own pre-run step "so planning never
 * mutates the tree". Nothing accumulates under a dry run either: no story is
 * dispatched, so no scratchpad file is written.
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

/** Options for {@link wipeScratchpad}. */
export interface WipeScratchpadOptions {
  /** When true, skip disk work entirely — a dry run must not delete anything. */
  dryRun?: boolean;
}

/**
 * Delete the run's scratchpad directory, tolerating absence and failure.
 *
 * Resolves for every outcome: the caller has no decision to make either way —
 * a failed wipe is reported and the run carries on.
 */
export async function wipeScratchpad(workdir: string, opts: WipeScratchpadOptions = {}): Promise<void> {
  if (opts.dryRun) return;
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
