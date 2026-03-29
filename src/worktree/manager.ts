import { existsSync, symlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
   * Creates a git worktree at .nax-wt/<storyId>/ with branch nax/<storyId>
   * and symlinks node_modules and .env from project root
   */
  async create(projectRoot: string, storyId: string): Promise<void> {
    validateStoryId(storyId);

    const worktreePath = join(projectRoot, ".nax-wt", storyId);
    const branchName = `nax/${storyId}`;

    try {
      // Create worktree with new branch
      const proc = _managerDeps.spawn(["git", "worktree", "add", worktreePath, "-b", branchName], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Failed to create worktree: ${stderr || "unknown error"}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        // Enhance error messages for common scenarios
        if (error.message.includes("not a git repository")) {
          throw new Error(`Not a git repository: ${projectRoot}`);
        }
        if (error.message.includes("already exists")) {
          throw new Error(`Worktree for story ${storyId} already exists at ${worktreePath}`);
        }
        throw error;
      }
      throw new Error(`Failed to create worktree: ${String(error)}`);
    }

    // Symlink node_modules if it exists
    const nodeModulesSource = join(projectRoot, "node_modules");
    if (existsSync(nodeModulesSource)) {
      const nodeModulesTarget = join(worktreePath, "node_modules");
      try {
        symlinkSync(nodeModulesSource, nodeModulesTarget, "dir");
      } catch (error) {
        // Clean up worktree if symlinking fails
        await this.remove(projectRoot, storyId);
        throw new Error(`Failed to symlink node_modules: ${errorMessage(error)}`);
      }
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
        throw new Error(`Failed to symlink .env: ${errorMessage(error)}`);
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

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        if (
          stderr.includes("not found") ||
          stderr.includes("does not exist") ||
          stderr.includes("no such worktree") ||
          stderr.includes("is not a working tree")
        ) {
          throw new Error(`Worktree not found: ${worktreePath}`);
        }
        throw new Error(`Failed to remove worktree: ${stderr || "unknown error"}`);
      }
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to remove worktree: ${String(error)}`);
    }

    // Delete branch
    try {
      const proc = _managerDeps.spawn(["git", "branch", "-D", branchName], {
        cwd: projectRoot,
        stdout: "pipe",
        stderr: "pipe",
      });

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
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

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`Failed to list worktrees: ${stderr || "unknown error"}`);
      }

      const stdout = await new Response(proc.stdout).text();
      return this.parseWorktreeList(stdout);
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to list worktrees: ${String(error)}`);
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
