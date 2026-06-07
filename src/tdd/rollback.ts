import { getLogger } from "../logger";
import { autoCommitIfDirty } from "../utils/git";

export const _rollbackDeps = {
  spawn: Bun.spawn as typeof Bun.spawn,
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

  const exitCode = await resetProc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(resetProc.stderr).text();
    logger.error("tdd", "Failed to rollback git changes", { ref, stderr });
    throw new Error(`Git rollback failed: ${stderr}`);
  }

  const cleanProc = _rollbackDeps.spawn(["git", "clean", "-fd"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const cleanExitCode = await cleanProc.exited;
  if (cleanExitCode !== 0) {
    const stderr = await new Response(cleanProc.stderr).text();
    logger.warn("tdd", "Failed to clean untracked files", { stderr });
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
export async function captureSnapshotRef(
  workdir: string,
  storyId: string,
  _deps: { autoCommitIfDirty?: typeof autoCommitIfDirty; spawn?: typeof Bun.spawn } = {},
): Promise<string> {
  const commit = _deps.autoCommitIfDirty ?? autoCommitIfDirty;
  const spawn = _deps.spawn ?? Bun.spawn;
  await commit(workdir, "non-blocking-fix-snapshot", "snapshot", storyId);
  const proc = spawn(["git", "rev-parse", "HEAD"], { cwd: workdir, stdout: "pipe", stderr: "pipe" });
  const sha = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return sha;
}
