import { errorMessage } from "@nathapp/nax-agent/internal";
import { STALE_RUN_TMP_MAX_AGE_MS, sweepStaleRunTmpRoots } from "../execution/lifecycle/run-tmp-sweep";
import { wipeRunTmp } from "../execution/lifecycle/run-tmp-wipe";
import { getSafeLogger } from "../logger";

export const _runTmpCloseDeps = { wipeRunTmp, sweepStaleRunTmpRoots, now: () => Date.now() };

/** Best-effort cleanup after a runtime's sessions have closed. */
export async function closeRunTmp(opts: { runId: string; dryRun: boolean }): Promise<void> {
  if (opts.dryRun) return;
  try {
    await _runTmpCloseDeps.wipeRunTmp(opts.runId);
  } catch (err) {
    getSafeLogger()?.warn("sandbox", "Failed to wipe run temp dir — continuing", {
      runId: opts.runId,
      error: errorMessage(err),
    });
  }
  try {
    await _runTmpCloseDeps.sweepStaleRunTmpRoots({
      currentRunId: opts.runId,
      now: _runTmpCloseDeps.now(),
      maxAgeMs: STALE_RUN_TMP_MAX_AGE_MS,
    });
  } catch (err) {
    getSafeLogger()?.warn("sandbox", "Failed to sweep run temp dirs — continuing", {
      runId: opts.runId,
      error: errorMessage(err),
    });
  }
}
