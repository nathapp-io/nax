/**
 * End-of-run temp-directory wipe (US-004).
 *
 * The complement of `scratchpad-wipe.ts`: it removes the run's OWN temp root
 * (`runTmpRoot(runId)` — `<parent>/<runId>` under the shared `/tmp/nax`, or the
 * per-user fallback), never a `/tmp/nax*` sweep — a concurrent run's live
 * directories share that prefix, and a crashed run's directory is left for the
 * OS to clear. It never removes the shared parent either, which the next run is
 * about to use. Unlike the scratchpad wipe it is NOT gated on `runCompleted`: a
 * failed run's `/tmp` files are not kept for inspection because no later run can
 * find them to clear.
 *
 * Failure is tolerated by design: a temp directory must never wedge a run.
 * Everything that is not absence is logged at warn and swallowed.
 *
 * #2300: `rm(..., { force: true })` does not raise on a missing path, so a wipe
 * aimed at the WRONG run id removed nothing AND said nothing — every run's temp
 * root survived the wipe that was supposed to remove it. The existence check
 * below is what makes absence observable.
 */

import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { getSafeLogger } from "@/logger";
import { runTmpRoot } from "@/sandbox";
import { errorMessage } from "@/utils/errors";

/** Injectable deps for the wipe (see docs/architecture/conventions.md §2). */
export const _runTmpWipeDeps = {
  remove: (path: string): Promise<void> => rm(path, { recursive: true, force: true }),
  /**
   * #2300 — one synchronous stat, so a wipe aimed at an id nothing was created
   * under is recorded instead of passing silently.
   */
  exists: (path: string): boolean => existsSync(path),
};

/** Options for {@link wipeRunTmp}. */
export interface WipeRunTmpOptions {
  /** When true, skip disk work entirely — a dry run must not delete anything. */
  dryRun?: boolean;
}

/**
 * Delete the run's temp root, tolerating absence and failure.
 *
 * Resolves for every outcome: the caller has no decision to make either way —
 * a failed wipe is reported and the run carries on.
 */
export async function wipeRunTmp(runId: string, opts: WipeRunTmpOptions = {}): Promise<void> {
  if (opts.dryRun) return;
  const path = runTmpRoot(runId);
  if (!_runTmpWipeDeps.exists(path)) {
    getSafeLogger()?.debug("sandbox", `Run temp dir absent — nothing to wipe: ${path}`, { runId, path });
    return;
  }
  try {
    await _runTmpWipeDeps.remove(path);
  } catch (err) {
    getSafeLogger()?.warn("sandbox", `Failed to wipe run temp dir ${path} — continuing`, {
      runId,
      path,
      error: errorMessage(err),
    });
  }
}
