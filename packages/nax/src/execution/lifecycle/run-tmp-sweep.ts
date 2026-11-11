import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { runTmpRoot } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { removeRunTmpTree } from "./run-tmp-wipe";

export const STALE_RUN_TMP_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const _runTmpSweepDeps = {
  readdir: (path: string): Promise<string[]> => readdir(path),
  lstat: (path: string) => lstat(path),
  remove: removeRunTmpTree,
};

interface SweepOptions {
  currentRunId: string;
  now: number;
  maxAgeMs: number;
}

async function sweepEntry(path: string, opts: SweepOptions): Promise<void> {
  const stats = await _runTmpSweepDeps.lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  const children = await _runTmpSweepDeps.readdir(path);
  let newest = stats.mtimeMs;
  for (const child of children) {
    const childStats = await _runTmpSweepDeps.lstat(join(path, child));
    newest = Math.max(newest, childStats.mtimeMs);
  }
  if (opts.now - newest > opts.maxAgeMs) await _runTmpSweepDeps.remove(path);
}

/** Sweep only siblings of the trusted run root, tolerating independent failures. */
export async function sweepStaleRunTmpRoots(opts: SweepOptions): Promise<void> {
  try {
    const root = runTmpRoot(opts.currentRunId);
    const parent = dirname(root);
    let entries: string[];
    try {
      entries = await _runTmpSweepDeps.readdir(parent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
        getSafeLogger()?.warn("sandbox", `Failed to list run temp dir ${parent} — continuing`, {
          error: errorMessage(err),
        });
      }
      return;
    }
    for (const entry of entries) {
      if (entry === basename(root)) continue;
      const path = join(parent, entry);
      try {
        await sweepEntry(path, opts);
      } catch (err) {
        getSafeLogger()?.warn("sandbox", `Failed to sweep stale run temp dir ${path} — continuing`, {
          error: errorMessage(err),
        });
      }
    }
  } catch (err) {
    getSafeLogger()?.warn("sandbox", "Failed to sweep run temp dirs — continuing", { error: errorMessage(err) });
  }
}
