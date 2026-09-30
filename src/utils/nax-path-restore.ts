/**
 * Best-effort restore of deleted/renamed `.nax/` paths before the snapshot
 * auto-commit stages the tree.
 *
 * Split out of `src/utils/git.ts` (which sits at the source file-size cap) so
 * the restore policy has one home. The git runner is injected rather than
 * imported, which keeps this module free of a cycle with `git.ts` and lets
 * tests drive it with a fake instead of a spawn mock.
 */

import type { Logger } from "../logger";
import { parsePorcelainForNaxPaths } from "./porcelain";

/** Runs `git <args>` from `cwd`. `gitWithTimeout` satisfies this. */
export type GitRunner = (args: string[], cwd: string) => Promise<{ exitCode: number; stderr: string }>;

export interface NaxRestoreContext {
  /** Repo root — porcelain paths are root-relative, so every git call runs from here. */
  gitRoot: string;
  run: GitRunner;
  logger: Logger | null;
  stage: string;
  role: string;
  storyId: string;
}

/** Exit status `git cat-file -e` gives for an object or path that does not exist (also an unborn HEAD). */
const GIT_NO_SUCH_OBJECT_EXIT = 128;

/**
 * False only when git positively answers that HEAD does not hold `path`: such
 * a path has no committed nax state, so restoring it would resurrect a blob
 * that was never committed (#2303). Any other non-zero exit (a timeout, which
 * `gitWithTimeout` reports as 1, or a killed process) is not an answer, so it
 * fails open and the restore is attempted as it always was. An unborn HEAD
 * answers 128, which is right: there is nothing to restore from.
 */
async function isInHead(run: GitRunner, gitRoot: string, path: string): Promise<boolean> {
  const { exitCode } = await run(["cat-file", "-e", `HEAD:${path}`], gitRoot);
  return exitCode !== GIT_NO_SUCH_OBJECT_EXIT;
}

/**
 * Restore every deleted/renamed `.nax/` path in `statusOutput` (the stdout of
 * `git status --porcelain`) that HEAD still holds. The snapshot auto-commit
 * swept an acceptance artifact deletion onto the branch after an agent treated
 * it as a stray test file; this repairs that before `git add -A`.
 *
 * A non-zero exit on restore is logged but never throws: the restore is
 * best-effort and the agent's edits still need to land.
 *
 * For staged deletions/renames (status letter in the index column) the index
 * no longer holds the old path — only HEAD does. `git checkout --` restores
 * from the index and would fail; `git checkout HEAD --` restores from the
 * commit and brings the file back into both the index and the worktree.
 */
export async function restoreDeletedNaxPaths(statusOutput: string, ctx: NaxRestoreContext): Promise<void> {
  const { gitRoot, run, logger, stage, role, storyId } = ctx;
  for (const { path, staged } of parsePorcelainForNaxPaths(statusOutput)) {
    if (!(await isInHead(run, gitRoot, path))) {
      logger?.debug(stage, "Skipping .nax/ path that HEAD does not hold; nothing to restore", {
        storyId,
        role,
        path,
        staged,
      });
      continue;
    }
    // AC-17: this log is intentionally `error`-level even on a successful
    // restore — the deletion it is repairing indicates an agent mistake
    // worth surfacing loudly, not routine operation. A failed restore logs
    // again below with the exit code and stderr.
    logger?.error(stage, "Restoring deleted .nax/ path before auto-commit", { storyId, role, path, staged });
    const checkoutArgs = staged ? ["checkout", "HEAD", "--", path] : ["checkout", "--", path];
    // Porcelain paths are repo-root-relative regardless of the cwd `git status`
    // ran from, so the restore must spawn from gitRoot too — matching the
    // `git add -A` staging call. Spawning from a monorepo package subdir makes
    // the pathspec resolve against the wrong root and the restore silently no-ops.
    const { exitCode, stderr } = await run(checkoutArgs, gitRoot);
    if (exitCode !== 0) {
      logger?.error(stage, "Failed to restore .nax/ path before auto-commit", {
        storyId,
        role,
        path,
        exitCode,
        stderr: stderr.trim(),
      });
    }
  }
}
