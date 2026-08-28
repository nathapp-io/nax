import { existsSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { validateStoryId } from "../prd/validate";
import { errorMessage } from "../utils/errors";
import { gitWithTimeout } from "../utils/git";
import { NAX_GITIGNORE_ENTRIES } from "../utils/gitignore";
import type { WorktreeInfo } from "./types";

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

    // BUG-39: serialize the read-modify-write of `.git/info/exclude` via the
    // path-keyed file lock so two concurrent ensureGitExcludes() callers
    // (e.g. parallel story setup) don't interleave read-read-write-write
    // and clobber each other's appended entries. Without this, the last
    // writer wins and one story's entries silently disappear. mkdir first
    // so the lock file can land in `.git/info/`.
    await mkdir(infoDir, { recursive: true });

    const { withPathFileLock } = await import("../utils/path-file-lock");
    try {
      await withPathFileLock(excludePath, async () => {
        let existing = "";
        if (existsSync(excludePath)) {
          existing = await Bun.file(excludePath).text();
        }

        // Line-aware matching: `existing.includes(entry)` would treat
        // `/foo/runs/` as already containing `runs/` and skip appending
        // `runs/` itself. Split into lines and match each line exactly so
        // a substring prefix never suppresses a longer entry.
        const existingLines = new Set(
          existing
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0),
        );
        const missing = NAX_GITIGNORE_ENTRIES.filter((entry) => !existingLines.has(entry));
        if (missing.length === 0) return;

        const section = `\n# nax — generated files (auto-added by nax parallel)\n${missing.join("\n")}\n`;
        await Bun.write(excludePath, existing + section);

        logger?.info("worktree", "Updated .git/info/exclude with nax entries", {
          added: missing.length,
        });
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
      const { stdout, exitCode } = await gitWithTimeout(["worktree", "list", "--porcelain"], projectRoot);
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
      // BUG-5: route through gitWithTimeout so a wedged git (NFS hang) can't stall create().
      await gitWithTimeout(["worktree", "prune"], projectRoot);
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
        // BUG-5: route through gitWithTimeout so a wedged git can't stall create().
        await gitWithTimeout(["branch", "-D", branchName], projectRoot);
      } catch {
        // branch may not exist — that's fine
      }
    }

    try {
      // Create worktree with new branch
      const { exitCode, stderr } = await gitWithTimeout(
        ["worktree", "add", worktreePath, "-b", branchName],
        projectRoot,
      );
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
      const { exitCode, stderr } = await gitWithTimeout(["worktree", "remove", worktreePath, "--force"], projectRoot);
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
      const { exitCode, stderr } = await gitWithTimeout(["branch", "-D", branchName], projectRoot);
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
      const { stdout, stderr, exitCode } = await gitWithTimeout(["worktree", "list", "--porcelain"], projectRoot);
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
        // BUG-24 (D-17): detached-HEAD worktrees (rebase, bisect) emit no
        // `branch` line — keep them with branch: null instead of dropping.
        if (currentWorktree.path) {
          worktrees.push({ path: currentWorktree.path, branch: currentWorktree.branch ?? null });
        }
        currentWorktree = {};
      }
    }

    // Handle last entry if no trailing newline
    if (currentWorktree.path) {
      worktrees.push({ path: currentWorktree.path, branch: currentWorktree.branch ?? null });
    }

    return worktrees;
  }
}
