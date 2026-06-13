import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { autoCommitIfDirty } from "../utils/git";

export const _rollbackDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
  autoCommitIfDirty,
};

/**
 * Rollback git changes to a specific ref.
 * Used when TDD fails to revert uncommitted/committed changes.
 */
export async function rollbackToRef(workdir: string, ref: string): Promise<void> {
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

  const cleanProc = _rollbackDeps.spawn(["git", "clean", "-fd"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [cleanExitCode, cleanStderr] = await Promise.all([cleanProc.exited, new Response(cleanProc.stderr).text()]);
  if (cleanExitCode !== 0) {
    logger.warn("tdd", "Failed to clean untracked files", { stderr: cleanStderr });
  }

  logger.info("tdd", "Successfully rolled back git changes", { ref });
}

/**
 * Capture the current (adversarial-passed) state as a restorable commit ref
 * (ADR-024 non-blocking-fix entry snapshot). Commits any uncommitted/untracked
 * story changes so they are TRACKED, then returns the resulting HEAD SHA.
 * Restore via rollbackToRef(workdir, sha): `git reset --hard sha` + `git clean -fd`
 * discards only the best-effort changes, NOT the story's committed files.
 */
export async function captureSnapshotRef(workdir: string, storyId: string): Promise<string> {
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
  return sha;
}
