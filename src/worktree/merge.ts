import { getSafeLogger } from "../logger";
import { spawn } from "../utils/bun-deps";
import { errorMessage } from "../utils/errors";
import type { WorktreeManager } from "./manager";

/** Injectable deps for testability — mock _mergeDeps.spawn instead of global Bun.spawn */
export const _mergeDeps = {
  spawn,
};

/**
 * Why a merge did not succeed.
 *
 * `conflict` — git left the repository mid-merge with unmerged paths. This is the
 * only kind that is rectifiable: there is a real textual conflict for an agent to
 * resolve.
 *
 * `error` — anything else: a dirty working tree, a missing branch, a repository
 * already stuck mid-merge, a spawn failure. There is no conflict to resolve, so
 * routing one of these into conflict rectification only spends an agent session
 * on a problem it cannot fix.
 */
export type MergeFailureKind = "conflict" | "error";

export interface MergeResult {
  success: boolean;
  storyId: string;
  conflictFiles?: string[];
  retryCount?: number;
  /** Set whenever `success` is false. */
  failureKind?: MergeFailureKind;
  /** Human-readable cause, carried on `failureKind: "error"` results. */
  error?: string;
}

export interface StoryDependencies {
  [storyId: string]: string[];
}

export class MergeEngine {
  constructor(private worktreeManager: WorktreeManager) {}

  /**
   * True when the repository has an in-progress merge — i.e. `MERGE_HEAD` resolves.
   *
   * This is the authoritative signal for "did a conflict happen?". Reading it from
   * git rather than string-matching stderr is what keeps one story's leftover state
   * from being reported as the next story's conflict: `git merge` into a repository
   * that is already mid-merge fails with "fatal: Exiting because of an unresolved
   * conflict", whose text contains "conflict" but says nothing about THIS merge.
   */
  private async isMidMerge(projectRoot: string): Promise<boolean> {
    const proc = _mergeDeps.spawn(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  }

  /**
   * Merges branch nax/<storyId> into the current branch with --no-ff.
   *
   * TOTAL over git-level failures — it never throws for them. Callers (`mergeAll`,
   * `pipeline-result-handler`) treat merging as one step in a longer sequence, so a
   * throw here aborted the whole batch and discarded the results of stories that had
   * already merged successfully. Every outcome is a value instead:
   *
   *   { success: true }                          clean merge, worktree cleaned up
   *   { success: false, failureKind: "conflict" } real conflict, aborted, rectifiable
   *   { success: false, failureKind: "error" }    everything else, NOT rectifiable
   */
  async merge(projectRoot: string, storyId: string): Promise<Omit<MergeResult, "storyId">> {
    const branchName = `nax/${storyId}`;

    try {
      // Guard: never merge into a repository that is already mid-merge. Doing so
      // fails in a way that reads like this story's own conflict, and would send an
      // innocent story to rectification carrying the previous story's file list.
      if (await this.isMidMerge(projectRoot)) {
        const error = `Repository has an unresolved merge in progress; refusing to merge ${branchName}`;
        getSafeLogger()?.error("worktree", "Refusing to merge into a mid-merge repository", {
          storyId,
          projectRoot,
        });
        return { success: false, failureKind: "error", error };
      }

      const mergeProc = _mergeDeps.spawn(
        ["git", "merge", "--no-ff", branchName, "-m", `Merge branch '${branchName}'`],
        {
          cwd: projectRoot,
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      const [exitCode, stderr, stdout] = await Promise.all([
        mergeProc.exited,
        new Response(mergeProc.stderr).text(),
        new Response(mergeProc.stdout).text(),
      ]);

      if (exitCode === 0) {
        // Clean merge - cleanup worktree
        try {
          await this.worktreeManager.remove(projectRoot, storyId);
        } catch (error) {
          // Log warning but don't fail the merge
          const logger = getSafeLogger();
          logger?.warn("worktree", `Failed to cleanup worktree for ${storyId}`, {
            error: errorMessage(error),
          });
        }

        return { success: true };
      }

      return await this.classifyMergeFailure(projectRoot, storyId, `${stdout}\n${stderr}`);
    } catch (error) {
      // Spawn-level failure (git missing, cwd gone). Still a value, not a throw.
      getSafeLogger()?.error("worktree", "Merge failed before git could report", {
        storyId,
        error: errorMessage(error),
      });
      return { success: false, failureKind: "error", error: errorMessage(error) };
    }
  }

  /**
   * Decide what a non-zero `git merge` exit actually was, by interrogating the
   * repository rather than pattern-matching stderr.
   */
  private async classifyMergeFailure(
    projectRoot: string,
    storyId: string,
    output: string,
  ): Promise<Omit<MergeResult, "storyId">> {
    const logger = getSafeLogger();
    const conflictFiles = await this.getConflictFiles(projectRoot);
    const midMerge = await this.isMidMerge(projectRoot);

    // No merge in progress and nothing unmerged => git refused before touching the
    // index (dirty tree, missing branch, unrelated histories). Not a conflict.
    if (!midMerge && conflictFiles.length === 0) {
      const error = output.trim() || "unknown error";
      logger?.error("worktree", "Merge failed for a non-conflict reason", {
        storyId,
        error,
      });
      return { success: false, failureKind: "error", error };
    }

    // A real conflict. Abort so the next story starts from a clean index — and if
    // the abort does not take, say so rather than reporting a tidy conflict: the
    // repository is now unusable for every merge that follows.
    if (!(await this.abortMerge(projectRoot))) {
      const error = `Merge conflict in ${storyId} could not be aborted; repository left mid-merge`;
      logger?.error("worktree", "git merge --abort failed — repository left mid-merge", {
        storyId,
        conflictFiles,
      });
      return { success: false, failureKind: "error", conflictFiles, error };
    }

    return { success: false, failureKind: "conflict", conflictFiles };
  }

  /**
   * Merges stories in topological order based on dependencies
   * On conflict: retries once after rebasing worktree on updated base
   * On 2nd conflict: marks story as failed, continues with remaining stories
   */
  async mergeAll(projectRoot: string, storyIds: string[], dependencies: StoryDependencies): Promise<MergeResult[]> {
    // Sort stories in topological order
    const orderedStories = this.topologicalSort(storyIds, dependencies);
    const results: MergeResult[] = [];
    const failedStories = new Set<string>();

    for (const storyId of orderedStories) {
      // Check if any dependencies failed
      const deps = dependencies[storyId] || [];
      const hasFailedDeps = deps.some((dep) => failedStories.has(dep));

      if (hasFailedDeps) {
        results.push({
          success: false,
          storyId,
          conflictFiles: [],
          failureKind: "error",
          error: `Skipped: depends on a story that failed to merge (${deps.filter((d) => failedStories.has(d)).join(", ")})`,
        });
        failedStories.add(storyId);
        continue;
      }

      // Try to merge
      let result = await this.merge(projectRoot, storyId);

      // Only a real conflict is worth a rebase-and-retry. A non-conflict error
      // (dirty tree, missing branch, repository stuck mid-merge) is not fixed by
      // rebasing, and retrying it just fails the same way twice.
      if (result.failureKind === "conflict") {
        try {
          // Rebase worktree on updated base
          await this.rebaseWorktree(projectRoot, storyId);

          // Retry merge
          result = await this.merge(projectRoot, storyId);

          // If still fails, mark as failed
          if (!result.success) {
            results.push({
              success: false,
              storyId,
              conflictFiles: result.conflictFiles,
              retryCount: 1,
              failureKind: result.failureKind ?? "error",
              error: result.error,
            });
            failedStories.add(storyId);
            continue;
          }

          // Success after retry
          results.push({
            success: true,
            storyId,
            retryCount: 1,
          });
        } catch (error) {
          // Rebase failed, mark as failed
          results.push({
            success: false,
            storyId,
            conflictFiles: result.conflictFiles,
            retryCount: 1,
            failureKind: "error",
            error: errorMessage(error),
          });
          failedStories.add(storyId);
        }
      } else if (result.success) {
        // First attempt succeeded
        results.push({
          success: true,
          storyId,
          retryCount: 0,
        });
      } else {
        // Non-conflict failure. Record it and carry on with the remaining stories —
        // this used to be unreachable because merge() threw instead of returning,
        // which took the whole batch (and every already-merged result) down with it.
        results.push({
          success: false,
          storyId,
          retryCount: 0,
          failureKind: result.failureKind ?? "error",
          error: result.error,
        });
        failedStories.add(storyId);
      }
    }

    return results;
  }

  /**
   * Topological sort of stories based on dependencies
   * Returns stories in order where dependencies come before dependents
   */
  private topologicalSort(storyIds: string[], dependencies: StoryDependencies): string[] {
    const visited = new Set<string>();
    const sorted: string[] = [];
    const visiting = new Set<string>();

    const visit = (storyId: string) => {
      if (visited.has(storyId)) {
        return;
      }

      if (visiting.has(storyId)) {
        throw new Error(`Circular dependency detected involving ${storyId}`);
      }

      visiting.add(storyId);

      // Visit dependencies first
      const deps = dependencies[storyId] || [];
      for (const dep of deps) {
        if (storyIds.includes(dep)) {
          visit(dep);
        }
      }

      visiting.delete(storyId);
      visited.add(storyId);
      sorted.push(storyId);
    };

    for (const storyId of storyIds) {
      visit(storyId);
    }

    return sorted;
  }

  /**
   * Rebases worktree on current base branch
   */
  private async rebaseWorktree(projectRoot: string, storyId: string): Promise<void> {
    const worktreePath = `${projectRoot}/.nax-wt/${storyId}`;

    try {
      // Get current branch name from main repo
      const currentBranchProc = _mergeDeps.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, currentBranchRaw] = await Promise.all([
        currentBranchProc.exited,
        new Response(currentBranchProc.stdout).text(),
      ]);
      if (exitCode !== 0) {
        throw new Error("Failed to get current branch");
      }

      const currentBranch = currentBranchRaw.trim();

      // Rebase worktree branch onto current branch
      const rebaseProc = _mergeDeps.spawn(["git", "rebase", currentBranch], {
        cwd: worktreePath,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [rebaseExitCode, rebaseStderr] = await Promise.all([
        rebaseProc.exited,
        new Response(rebaseProc.stderr).text(),
      ]);
      if (rebaseExitCode !== 0) {
        const stderr = rebaseStderr;

        // Abort rebase on failure
        const abortProc = _mergeDeps.spawn(["git", "rebase", "--abort"], {
          cwd: worktreePath,
          stdout: "pipe",
          stderr: "pipe",
        });
        await abortProc.exited;

        throw new Error(`Rebase failed: ${stderr || "unknown error"}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to rebase worktree ${storyId}: ${String(error)}`);
    }
  }

  /**
   * Gets list of conflicted files
   */
  private async getConflictFiles(projectRoot: string): Promise<string[]> {
    try {
      const proc = _mergeDeps.spawn(["git", "diff", "--name-only", "--diff-filter=U"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      if (exitCode !== 0) {
        return [];
      }
      return stdout
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Aborts an in-progress merge. Returns whether the repository was actually
   * returned to a clean state.
   *
   * The exit code is load-bearing: a failed abort leaves MERGE_HEAD set, and every
   * subsequent `git merge` in the batch then fails with text containing "conflict",
   * which used to be attributed to whichever story merged next. Callers must be able
   * to tell "conflict, cleaned up" from "conflict, repository still broken".
   */
  private async abortMerge(projectRoot: string): Promise<boolean> {
    try {
      const proc = _mergeDeps.spawn(["git", "merge", "--abort"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (exitCode !== 0) {
        getSafeLogger()?.error("worktree", "Failed to abort merge", {
          exitCode,
          stderr: stderr.trim(),
        });
        return false;
      }
      return true;
    } catch (error) {
      getSafeLogger()?.error("worktree", "Failed to abort merge", {
        error: errorMessage(error),
      });
      return false;
    }
  }
}
