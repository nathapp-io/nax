import { getLogger } from "../logger";

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
