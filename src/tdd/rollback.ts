import { rm } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { autoCommitIfDirty, getGitRoot, getUntrackedPaths } from "../utils/git";

export const _rollbackDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
  autoCommitIfDirty,
  getUntrackedPaths,
  getGitRoot,
  rm,
};

/**
 * Rollback git changes to a specific ref.
 *
 * `untrackedBefore` is a snapshot of untracked paths taken at phase start
 * (before the agent ran) — see `getUntrackedPaths`. Rollback deletes only the
 * untracked paths that appeared SINCE that snapshot (BUG-07): a blanket
 * `git clean -fd` would also delete untracked files that predate the phase —
 * the user's `.env`, WIP notes — which have nothing to do with the agent's
 * failed attempt. Paths already untracked at snapshot time are left alone.
 *
 * `untrackedBefore` is `null` when the baseline snapshot itself failed (git
 * error/timeout) — an unknown baseline is never treated as an empty one, so
 * the untracked cleanup is skipped entirely rather than risk deleting files
 * that predate the phase. Same rule applies if the post-reset snapshot fails.
 */
export async function rollbackToRef(workdir: string, ref: string, untrackedBefore: string[] | null): Promise<void> {
  const logger = getLogger();
  logger.warn("tdd", "Rolling back git changes", { ref });

  const resetProc = _rollbackDeps.spawn(["git", "reset", "--hard", ref], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, resetStderr] = await Promise.all([resetProc.exited, new Response(resetProc.stderr).text()]);
  if (exitCode !== 0) {
    logger.error("tdd", "Failed to rollback git changes", { ref, stderr: resetStderr });
    throw new Error(`Git rollback failed: ${resetStderr}`);
  }

  if (untrackedBefore === null) {
    logger.warn("tdd", "Untracked-paths baseline unavailable — skipping untracked cleanup", { ref });
  } else {
    const untrackedNow = await _rollbackDeps.getUntrackedPaths(workdir);
    if (untrackedNow === null) {
      logger.warn("tdd", "Post-reset untracked-paths read failed — skipping untracked cleanup", { ref });
    } else {
      const before = new Set(untrackedBefore);
      const appearedSincePhaseStart = untrackedNow.filter((p) => !before.has(p));
      // Porcelain paths are always repo-root-relative, independent of the cwd git
      // was spawned from — resolve against the real git root, not `workdir` (which
      // may be a package subdirectory in a monorepo), or the join silently misses.
      const root = (await _rollbackDeps.getGitRoot(workdir)) ?? workdir;

      for (const relPath of appearedSincePhaseStart) {
        try {
          await _rollbackDeps.rm(join(root, relPath), { recursive: true, force: true });
        } catch (err) {
          logger.warn("tdd", "Failed to clean untracked file", {
            path: relPath,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      logger.info("tdd", "Untracked cleanup complete", { ref, untrackedCleaned: appearedSincePhaseStart.length });
    }
  }

  logger.info("tdd", "Successfully rolled back git changes", { ref });
}

export interface SnapshotRef {
  sha: string;
  /** Untracked paths present right after the commit — the BUG-07 rollback baseline. `null` if the read failed. */
  untrackedBefore: string[] | null;
}

/**
 * Capture the current (adversarial-passed) state as a restorable commit ref
 * (ADR-024 non-blocking-fix entry snapshot). Commits any uncommitted/untracked
 * story changes so they are TRACKED, then returns the resulting HEAD SHA plus
 * an untracked-paths snapshot for `rollbackToRef`'s BUG-07 diff-based clean.
 * Restore via rollbackToRef(workdir, sha, untrackedBefore).
 */
export async function captureSnapshotRef(workdir: string, storyId: string): Promise<SnapshotRef> {
  await _rollbackDeps.autoCommitIfDirty(workdir, "non-blocking-fix-snapshot", "snapshot", storyId);
  const proc = _rollbackDeps.spawn(["git", "rev-parse", "HEAD"], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
  const [exitCode, shaRaw] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  const sha = shaRaw.trim();
  if (exitCode !== 0) {
    throw new NaxError("git rev-parse HEAD failed in non-blocking-fix snapshot", "SNAPSHOT_REF_FAILED", {
      storyId,
      workdir,
      stage: "non-blocking-fix-snapshot",
    });
  }
  const untrackedBefore = await _rollbackDeps.getUntrackedPaths(workdir);
  return { sha, untrackedBefore };
}
