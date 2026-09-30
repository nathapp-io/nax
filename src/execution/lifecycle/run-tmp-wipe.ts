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

import { lstatSync } from "node:fs";
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
   *
   * Errno-aware, and throws for everything but ENOENT, because the guard has to
   * be exactly as sure as `rm`: `rm(..., { force: true })` swallows ENOENT and
   * only ENOENT, so a path that IS there but cannot be inspected (EACCES on a
   * non-searchable ancestor, ENOTDIR where an ancestor is a file) is a failure,
   * not an absence. `existsSync` collapsed both to "absent" and downgraded them
   * to debug, in a module whose whole contract is that a failure is reported.
   *
   * `lstat`, not `stat`: a DANGLING symlink is a path `rm` unlinks and
   * `existsSync` (which follows links) reports absent, so `existsSync` would
   * have left it behind.
   */
  exists: (path: string): boolean => {
    try {
      lstatSync(path);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return false;
    }
  },
};

/** What one presence check concluded. A failed check is not an absence. */
type Presence =
  | { readonly state: "present" }
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly error: string };

function inspect(path: string): Presence {
  try {
    return _runTmpWipeDeps.exists(path) ? { state: "present" } : { state: "absent" };
  } catch (err) {
    return { state: "unreadable", error: errorMessage(err) };
  }
}

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
  const seen = inspect(path);
  if (seen.state === "absent") {
    getSafeLogger()?.debug("sandbox", `Run temp dir absent — nothing to wipe: ${path}`, { runId, path });
    return;
  }
  if (seen.state === "unreadable") {
    // Report the inspection failure AND still try the removal: `rm` ignores
    // ENOENT, so it is safe on a path that turns out to be gone, and it is the
    // only thing left to try on a path that turns out to be there. Pre-guard
    // this was the only record the case produced, at the same severity.
    getSafeLogger()?.warn("sandbox", `Could not inspect run temp dir ${path} — wiping it anyway`, {
      runId,
      path,
      error: seen.error,
    });
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
