import { existsSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { validateStoryId } from "../prd/validate";
import { spawn } from "../utils/bun-deps";
import { errorMessage } from "../utils/errors";
import { NAX_GITIGNORE_ENTRIES } from "../utils/gitignore";
import type { WorktreeInfo } from "./types";

/** Injectable deps for testability — mock _managerDeps.spawn instead of global Bun.spawn */
export const _managerDeps = {
  spawn,
};

export class WorktreeManager {
  /**
   * Ensures nax runtime files are excluded from git in all worktrees by writing
   * to .git/info/exclude — which is never committed and applies across all linked
   * worktrees sharing this repo.
   *
   * This prevents acp-sessions.json and other nax runtime files from being
   * committed in parallel story worktrees, which causes merge conflicts even when
   * the actual implementation files don't overlap.
   *
   * Call once before creating worktrees for a parallel batch.
   */
  async ensureGitExcludes(projectRoot: string): Promise<void> {
    const logger = getSafeLogger();
    const infoDir = join(projectRoot, ".git", "info");
    const excludePath = join(infoDir, "exclude");

    try {
      await mkdir(infoDir, { recursive: true });

      let existing = "";
      if (existsSync(excludePath)) {
        existing = await Bun.file(excludePath).text();
      }

      const missing = NAX_GITIGNORE_ENTRIES.filter((entry) => !existing.includes(entry));
      if (missing.length === 0) return;

      const section = `\n# nax — generated files (auto-added by nax parallel)\n${missing.join("\n")}\n`;
      await Bun.write(excludePath, existing + section);

      logger?.info("worktree", "Updated .git/info/exclude with nax entries", {
        added: missing.length,
      });
    } catch (error) {
      // Non-fatal — log warning and continue. Worktrees may still get conflicts
      // if the project's .gitignore is also missing these entries.
      logger?.warn("worktree", "Failed to update .git/info/exclude", {
        error: errorMessage(error),
      });
    }
  }

  /**
   * BUG-28: checks `git worktree list` for a record (live or prunable) of a
   * worktree checked out to `branchName`, BEFORE any cleanup runs. This is
   * the only reliable proof that the branch was created by a prior nax
   * worktree — git has no other durable link between a branch and the
   * worktree that created it once the worktree directory is gone. Matched by
   * branch (not path) so it isn't defeated by TMPDIR symlinks (e.g. macOS
   * /var → /private/var) making a naive path comparison miss real matches.
   */
  private async hasWorktreeRecord(projectRoot: string, branchName: string): Promise<boolean> {
    try {
      const proc = _managerDeps.spawn(["git", "worktree", "list", "--porcelain"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
      if (exitCode !== 0) return false;

      const targetBranch = `refs/heads/${branchName}`;
      return stdout
        .split("\n")
        .filter((line) => line.startsWith("branch "))
        .some((line) => line.slice("branch ".length).trim() === targetBranch);
    } catch {
      return false;
    }
  }

  /**
   * Creates a git worktree at .nax-wt/<storyId>/ with branch nax/<storyId>.
   * Dependency preparation is handled outside WorktreeManager; only non-dependency
   * runtime files such as .env are mirrored here when present.
   *
   * If a worktree or branch for this story already exists (orphaned from a
   * previous crashed run), it is removed first so we get a clean slate.
   */
  async create(projectRoot: string, storyId: string): Promise<void> {
    validateStoryId(storyId);

    const worktreePath = join(projectRoot, ".nax-wt", storyId);
    const branchName = `nax/${storyId}`;

    // BUG-28: Step 3 below force-deletes `branchName` when remove() (Step 2)
    // found no live worktree to remove it via — that path used to run
    // unconditionally, which can destroy an unmerged *user* branch that
    // happens to share this name. `git worktree list` is captured before any
    // cleanup runs specifically so a since-pruned/deleted-directory worktree
    // still counts as proof this branch pair was actually created by nax's
    // own create() — only then is Step 3's force-delete "known-orphaned"
    // rather than a guess.
    const hadWorktreeRecord = await this.hasWorktreeRecord(projectRoot, branchName);

    // Clean up any stale worktree/branch from a previous crashed run.
    // Three cleanup steps handle all orphaned-worktree scenarios:
    // 1. `git worktree prune` — removes admin refs whose directories no longer exist
    // 2. `git worktree remove --force` — removes worktree (and its branch) if directory still exists
    // 3. `git branch -D` — removes a leftover branch whose worktree directory is already
    //    gone, but ONLY when hadWorktreeRecord proved it as a nax-created orphan
    try {
      // Step 1: Prune orphaned worktree references (dir deleted but .git/worktrees/ entry remains)
      const pruneProc = _managerDeps.spawn(["git", "worktree", "prune"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      await pruneProc.exited;
    } catch {
      // prune is best-effort
    }

    let removedLiveWorktree = false;
    try {
      // Step 2: Remove worktree if it still exists as a live worktree (remove()
      // also force-deletes branchName once the worktree removal succeeds).
      await this.remove(projectRoot, storyId);
      removedLiveWorktree = true;
    } catch {
      // remove() throws if worktree doesn't exist — that's fine
    }

    if (!removedLiveWorktree && hadWorktreeRecord) {
      try {
        // Step 3: the worktree directory is already gone (remove() found
        // nothing), but hadWorktreeRecord proves this branch/worktree pair
        // was created by a prior nax run — safe to force-delete the orphan.
        const branchProc = _managerDeps.spawn(["git", "branch", "-D", branchName], {
          cwd: projectRoot,
          stdout: "pipe",
          stderr: "pipe",
        });
        await branchProc.exited;
      } catch {
        // branch may not exist — that's fine
      }
    }

    try {
      // Create worktree with new branch
      const proc = _managerDeps.spawn(["git", "worktree", "add", worktreePath, "-b", branchName], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (exitCode !== 0) {
        throw new NaxError(`Failed to create worktree: ${stderr || "unknown error"}`, "WORKTREE_ERROR", {
          stage: "worktree",
          storyId,
          projectRoot,
          stderr,
        });
      }
    } catch (error) {
      if (error instanceof NaxError) {
        throw error;
      }
      if (error instanceof Error) {
        // Enhance error messages for common scenarios
        if (error.message.includes("not a git repository")) {
          throw new NaxError(`Not a git repository: ${projectRoot}`, "WORKTREE_ERROR", {
            stage: "worktree",
            storyId,
            projectRoot,
          });
        }
        throw new NaxError(error.message, "WORKTREE_ERROR", {
          stage: "worktree",
          storyId,
          projectRoot,
          cause: error,
        });
      }
      throw new NaxError(`Failed to create worktree: ${String(error)}`, "WORKTREE_ERROR", {
        stage: "worktree",
        storyId,
        projectRoot,
      });
    }

    // Symlink .env if it exists
    const envSource = join(projectRoot, ".env");
    if (existsSync(envSource)) {
      const envTarget = join(worktreePath, ".env");
      try {
        symlinkSync(envSource, envTarget, "file");
      } catch (error) {
        // Clean up worktree if symlinking fails
        await this.remove(projectRoot, storyId);
        throw new NaxError(`Failed to symlink .env: ${errorMessage(error)}`, "WORKTREE_ERROR", {
          stage: "worktree",
          storyId,
          envSource,
          envTarget,
        });
      }
    }
  }

  /**
   * Removes worktree and deletes branch
   */
  async remove(projectRoot: string, storyId: string): Promise<void> {
    validateStoryId(storyId);

    const worktreePath = join(projectRoot, ".nax-wt", storyId);
    const branchName = `nax/${storyId}`;

    // Remove worktree
    try {
      const proc = _managerDeps.spawn(["git", "worktree", "remove", worktreePath, "--force"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (exitCode !== 0) {
        if (
          stderr.includes("not found") ||
          stderr.includes("does not exist") ||
          stderr.includes("no such worktree") ||
          stderr.includes("is not a working tree")
        ) {
          throw new NaxError(`Worktree not found: ${worktreePath}`, "WORKTREE_ERROR", {
            stage: "worktree",
            storyId,
            worktreePath,
          });
        }
        throw new NaxError(`Failed to remove worktree: ${stderr || "unknown error"}`, "WORKTREE_ERROR", {
          stage: "worktree",
          storyId,
          worktreePath,
          stderr,
        });
      }
    } catch (error) {
      if (error instanceof NaxError) {
        throw error;
      }
      throw new NaxError(error instanceof Error ? error.message : String(error), "WORKTREE_ERROR", {
        stage: "worktree",
        storyId,
        worktreePath,
        cause: error instanceof Error ? error : undefined,
      });
    }

    // Delete branch
    try {
      const proc = _managerDeps.spawn(["git", "branch", "-D", branchName], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      if (exitCode !== 0) {
        // Don't fail if branch doesn't exist
        if (!stderr.includes("not found")) {
          const logger = getSafeLogger();
          logger?.warn("worktree", `Failed to delete branch ${branchName}`, { stderr });
        }
      }
    } catch (error) {
      // Log warning but don't fail - worktree is already removed
      const logger = getSafeLogger();
      logger?.warn("worktree", `Failed to delete branch ${branchName}`, {
        error: errorMessage(error),
      });
    }
  }

  /**
   * Returns active worktrees
   */
  async list(projectRoot: string): Promise<WorktreeInfo[]> {
    try {
      const proc = _managerDeps.spawn(["git", "worktree", "list", "--porcelain"], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [exitCode, stderr, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
        new Response(proc.stdout).text(),
      ]);
      if (exitCode !== 0) {
        throw new NaxError(`Failed to list worktrees: ${stderr || "unknown error"}`, "WORKTREE_ERROR", {
          stage: "worktree",
          projectRoot,
          stderr,
        });
      }

      return this.parseWorktreeList(stdout);
    } catch (error) {
      if (error instanceof NaxError) {
        throw error;
      }
      throw new NaxError(error instanceof Error ? error.message : String(error), "WORKTREE_ERROR", {
        stage: "worktree",
        projectRoot,
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  /**
   * Parses git worktree list --porcelain output
   */
  private parseWorktreeList(output: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = [];
    const lines = output.trim().split("\n");

    let currentWorktree: Partial<WorktreeInfo> = {};

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentWorktree.path = line.substring("worktree ".length);
      } else if (line.startsWith("branch ")) {
        currentWorktree.branch = line.substring("branch ".length).replace("refs/heads/", "");
      } else if (line === "") {
        // Empty line indicates end of worktree entry
        if (currentWorktree.path && currentWorktree.branch) {
          worktrees.push(currentWorktree as WorktreeInfo);
        }
        currentWorktree = {};
      }
    }

    // Handle last entry if no trailing newline
    if (currentWorktree.path && currentWorktree.branch) {
      worktrees.push(currentWorktree as WorktreeInfo);
    }

    return worktrees;
  }
}
