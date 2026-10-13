/**
 * Run-end sweep for hidden `.nax/` index entries (#2490).
 *
 * An agent that runs `git update-index --skip-worktree` (or `--assume-unchanged`)
 * on nax's run state hides the file from `git status`, `git diff` and nax's own
 * auto-commit, and the flag outlives the run in the user's index. The tool
 * policy refuses the command; this is the defence in depth for any path that
 * got past it. `git ls-files -v` tags a skip-worktree entry `S` and an
 * assume-unchanged entry with a lowercase letter.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { gitWithTimeout } from "./git";

/** Every `.nax` directory in the repo, root or nested (`pkg/.nax/...`). */
const NAX_PATHSPEC = ":(glob)**/.nax/**";

export interface IndexFlagLogger {
  warn(stage: string, message: string, data?: Record<string, unknown>): void;
}

function isHiddenTag(tag: string): boolean {
  return tag === "S" || (tag >= "a" && tag <= "z");
}

/** Paths under `.nax/` carrying a skip-worktree or assume-unchanged bit. */
async function hiddenNaxPaths(workdir: string): Promise<string[]> {
  const { stdout, exitCode } = await gitWithTimeout(["ls-files", "-v", "-z", "--", NAX_PATHSPEC], workdir);
  if (exitCode !== 0) return [];
  return stdout
    .split("\0")
    .filter((entry) => entry.length > 2 && isHiddenTag(entry[0] as string))
    .map((entry) => entry.slice(2));
}

/**
 * Clear the bits on every hidden `.nax/` path and warn once per path.
 * Best-effort: any git failure is swallowed (logged at the call site's level)
 * so the sweep can never fail a run. Returns the paths it cleared.
 */
export async function clearNaxIndexFlags(
  workdir: string,
  logger: IndexFlagLogger | null | undefined,
): Promise<string[]> {
  const cleared: string[] = [];
  try {
    for (const path of await hiddenNaxPaths(workdir)) {
      // Two calls: git applies only one of the two --no- flags when both are
      // passed together, leaving the other bit set.
      const skip = await gitWithTimeout(["update-index", "--no-skip-worktree", "--", path], workdir);
      const assume = await gitWithTimeout(["update-index", "--no-assume-unchanged", "--", path], workdir);
      if (skip.exitCode !== 0 || assume.exitCode !== 0) continue;
      cleared.push(path);
      logger?.warn("run-end", "Cleared a skip-worktree/assume-unchanged flag on nax run state", {
        storyId: "_run",
        path,
      });
    }
  } catch (err) {
    logger?.warn("run-end", "Index flag sweep failed", { storyId: "_run", error: errorMessage(err) });
  }
  return cleared;
}
