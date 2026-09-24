import { existsSync, symlinkSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import { gitWithTimeout } from "../utils/git";
import { NAX_GITIGNORE_ENTRIES } from "../utils/gitignore";
import { naxOrphanRefName } from "./nax-orphan-ref";
import type { WorktreeInfo } from "./types";
import type { WorktreeId } from "./worktree-id";
import { storyBranchName, storyWorktreePath } from "./worktree-id";

/**
 * Injectable git subprocess seam. Tests stub `gitWithTimeout` to drive
 * `create()` and `remove()` end to end without spawning real git.
 *
 * @internal
 */
export const _worktreeManagerDeps = {
  gitWithTimeout,
};

/**
 * The `info/` dir git reads `exclude` from for `projectRoot` (#2216).
 *
 * When `.git` is a directory (a main checkout) — or absent, which the unit
 * suite relies on — this is `<projectRoot>/.git/info`, unchanged. When `.git`
 * is a FILE (a linked worktree's `gitdir:` pointer) it is the COMMON dir's
 * `info/`: git reads `info/exclude` only from there, never from the
 * per-worktree `.git/worktrees/<name>/info/`. `rev-parse` is asked only in
 * that case, so it can never walk up from a non-repo dir into an enclosing
 * repository.
 */
async function resolveGitInfoDir(projectRoot: string): Promise<string> {
  const dotGit = join(projectRoot, ".git");
  // stat, not lstat: a `.git` symlink to a pointer file is still a pointer file.
  const isPointerFile = await stat(dotGit).then(
    (s) => s.isFile(),
    () => false,
  );
  if (!isPointerFile) return join(dotGit, "info");

  const { stdout, stderr, exitCode } = await _worktreeManagerDeps.gitWithTimeout(
    ["rev-parse", "--git-common-dir"],
    projectRoot,
  );
  const commonDir = stdout.trim();
  if (exitCode !== 0 || commonDir === "") {
    throw new NaxError(`Could not resolve the git common dir: ${stderr.trim() || "empty output"}`, "WORKTREE_ERROR", {
      stage: "worktree",
      projectRoot,
      stderr,
    });
  }
  // rev-parse prints a path relative to its cwd when the common dir is below it.
  return join(resolve(projectRoot, commonDir), "info");
}

export class WorktreeManager {
  /**
   * Ensures nax runtime files are excluded from git in all worktrees by writing
   * to .git/info/exclude — which is never committed and applies across all linked
   * worktrees sharing this repo. From a linked worktree the file written is the
   * common dir's (see resolveGitInfoDir).
   *
   * This prevents acp-sessions.json and other nax runtime files from being
   * committed in parallel story worktrees, which causes merge conflicts even when
   * the actual implementation files don't overlap.
   *
   * Call once before creating worktrees for a parallel batch.
   *
   * Never throws: any failure, including resolving the git dir, is logged at
   * warn and the call resolves.
   */
  async ensureGitExcludes(projectRoot: string): Promise<void> {
    const logger = getSafeLogger();

    try {
      const infoDir = await resolveGitInfoDir(projectRoot);
      const excludePath = join(infoDir, "exclude");

      // BUG-39: serialize the read-modify-write of `.git/info/exclude` via the
      // path-keyed file lock so two concurrent ensureGitExcludes() callers
      // (e.g. parallel story setup) don't interleave read-read-write-write
      // and clobber each other's appended entries. Without this, the last
      // writer wins and one story's entries silently disappear. mkdir first
      // so the lock file can land in `.git/info/`.
      await mkdir(infoDir, { recursive: true });

      const { withPathFileLock } = await import("../utils/path-file-lock");
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
        projectRoot,
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
      const { stdout, exitCode } = await _worktreeManagerDeps.gitWithTimeout(
        ["worktree", "list", "--porcelain"],
        projectRoot,
      );
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
   * US-002: checks for a nax-owned orphan ref on
   * `refs/nax/orphan/<worktreeId>`. Written by `removeWorktreeDirectory`
   * in `pipeline-result-handler.ts` when a non-conflict merge failure
   * leaves a worktree-less branch behind. Read here as Step-3 evidence
   * that the branch `nax/<worktreeId>` was created by a prior nax run —
   * so the force-delete in Step 3 is known-orphaned rather than a guess.
   * The ref cannot outlive what it records (it is removed in the same
   * step that deletes the branch), so reading it always describes state
   * that existed between this run and the previous one.
   *
   * US-002 narrows the parameter to `WorktreeId` — the writer in
   * `pipeline-result-handler.ts` reaches this same helper through the
   * composed identity rather than a raw story ID (US-003 closes the
   * writer site). A raw `refs/nax/orphan/<rawStoryId>` spelling never
   * enters the system: the brand forbids it at the type level.
   */
  private async hasNaxOwnershipRecord(projectRoot: string, worktreeId: WorktreeId): Promise<boolean> {
    const orphanRef = naxOrphanRefName(worktreeId);
    try {
      const { exitCode } = await _worktreeManagerDeps.gitWithTimeout(["cat-file", "-e", orphanRef], projectRoot);
      return exitCode === 0;
    } catch {
      return false;
    }
  }

  private async resolveGitRef(projectRoot: string, refName: string): Promise<string | undefined> {
    try {
      const { exitCode, stdout } = await _worktreeManagerDeps.gitWithTimeout(
        ["rev-parse", "--verify", refName],
        projectRoot,
      );
      const resolved = stdout.trim();
      return exitCode === 0 && resolved ? resolved : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Creates a git worktree at `<root>/.nax-wt/<worktreeId>/` with branch
   * `nax/<worktreeId>`. Dependency preparation is handled outside
   * WorktreeManager; only non-dependency runtime files such as `.env`
   * are mirrored here when present.
   *
   * US-002 narrows the second parameter to `WorktreeId` — the parameter
   * is the COMPOSED identity `story-<feature>-<storyId>` (or `bakeoff-...`),
   * never a raw story ID. The directory and branch are derived through
   * `storyWorktreePath(projectRoot, worktreeId)` /
   * `storyBranchName(worktreeId)` so this function never spells the path
   * or branch literal itself; the gate enforces the SSOT.
   *
   * If a worktree or branch for this identity already exists (orphaned
   * from a previous crashed run), it is removed first so we get a clean
   * slate. The orphan-ref probe at `refs/nax/orphan/<worktreeId>` is the
   * Step-3 evidence described in BUG-28.
   */
  async create(projectRoot: string, worktreeId: WorktreeId): Promise<void> {
    const worktreePath = storyWorktreePath(projectRoot, worktreeId);
    const branchName = storyBranchName(worktreeId);
    const orphanRef = naxOrphanRefName(worktreeId);

    // BUG-28: Step 3 below force-deletes `branchName` when remove() (Step 2)
    // found no live worktree to remove it via — that path used to run
    // unconditionally, which can destroy an unmerged *user* branch that
    // happens to share this name. `git worktree list` is captured before any
    // cleanup runs specifically so a since-pruned/deleted-directory worktree
    // still counts as proof this branch pair was actually created by nax's
    // own create() — only then is Step 3's force-delete "known-orphaned"
    // rather than a guess.
    //
    // US-002: `hasNaxOwnershipRecord` is the second form of evidence the
    // owning run may have left behind. `removeWorktreeDirectory` writes
    // `refs/nax/orphan/<worktreeId>` after a non-conflict merge failure,
    // so a retry path can still distinguish a nax-created orphan from a
    // user branch. Step 3 fires on EITHER signal; the orphan ref is
    // cleared in the same step that deletes the branch, so the record
    // cannot outlive what it records. A user branch named
    // `nax/<something-else>` that nax never created has neither form of
    // evidence and is still never force-deleted.
    const hadWorktreeRecord = await this.hasWorktreeRecord(projectRoot, branchName);
    const hadNaxOwnershipRecord = await this.hasNaxOwnershipRecord(projectRoot, worktreeId);
    const orphanCommit = hadNaxOwnershipRecord ? await this.resolveGitRef(projectRoot, orphanRef) : undefined;
    const branchRef = `refs/heads/${branchName}`;
    const branchCommit = await this.resolveGitRef(projectRoot, branchRef);
    const orphanMatchesBranch = orphanCommit !== undefined && orphanCommit === branchCommit;

    // Clean up any stale worktree/branch from a previous crashed run.
    // Three cleanup steps handle all orphaned-worktree scenarios:
    // 1. `git worktree prune` — removes admin refs whose directories no longer exist
    // 2. `git worktree remove --force` — removes worktree (and its branch) if directory still exists
    // 3. `git branch -D` — removes a leftover branch whose worktree directory is already
    //    gone, but ONLY when hadWorktreeRecord OR hadNaxOwnershipRecord proved it
    //    as a nax-created orphan. The orphan ref is then cleared with `git update-ref -d`.
    try {
      // Step 1: Prune orphaned worktree references (dir deleted but .git/worktrees/ entry remains)
      // BUG-5: route through gitWithTimeout so a wedged git (NFS hang) can't stall create().
      await _worktreeManagerDeps.gitWithTimeout(["worktree", "prune"], projectRoot);
    } catch {
      // prune is best-effort
    }

    let removedLiveWorktree = false;
    try {
      // Step 2: Remove worktree if it still exists as a live worktree (remove()
      // also force-deletes branchName once the worktree removal succeeds).
      await this.remove(projectRoot, worktreeId);
      removedLiveWorktree = true;
    } catch (error) {
      // remove() throws WORKTREE_NOT_FOUND when there is nothing to clean up —
      // that is the expected clean-slate case for a fresh run, so stay silent.
      // Any other NaxError carries a genuine git failure (e.g. could not lock
      // ref) that the subsequent `worktree add` will surface again — log it now
      // so the upstream cause is visible before the second failure masks it.
      if (!(error instanceof NaxError) || error.code !== "WORKTREE_NOT_FOUND") {
        const logger = getSafeLogger();
        logger?.warn("worktree", "Step-2 remove failed before create", {
          worktreeId,
          projectRoot,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let clearedBranch = removedLiveWorktree;
    if (!removedLiveWorktree && (hadWorktreeRecord || orphanMatchesBranch)) {
      // Step 3: the worktree directory is already gone (remove() found
      // nothing), but hadWorktreeRecord OR hadNaxOwnershipRecord proves
      // this branch/worktree pair was created by a prior nax run — safe
      // to force-delete the orphan. BUG-5: route through gitWithTimeout
      // so a wedged git can't stall create().
      if (orphanMatchesBranch) {
        const result = await _worktreeManagerDeps
          .gitWithTimeout(["update-ref", "-d", branchRef, orphanCommit], projectRoot)
          .catch(() => undefined);
        clearedBranch = result?.exitCode === 0;
      } else {
        const result = await _worktreeManagerDeps
          .gitWithTimeout(["branch", "-D", branchName], projectRoot)
          .catch(() => undefined);
        clearedBranch = result?.exitCode === 0;
      }
    }

    // US-002: Always clear the orphan ref at the end of cleanup, regardless
    // of which step fired. The record cannot outlive what it records — and
    // if Step 2 succeeded, `remove()` already deleted the branch, so the ref
    // would be dangling at a now-unreachable commit. If neither step fired
    // (no evidence), `update-ref -d` is a no-op (the ref doesn't exist).
    // Best-effort: a stale ref that survives one more run is acceptable;
    // a dangling ref that misleads Step-3 evidence on a *later* run is
    // not — that is the BUG-28 hole this record was designed to close.
    if (hadNaxOwnershipRecord && (clearedBranch || !orphanMatchesBranch)) {
      try {
        await _worktreeManagerDeps.gitWithTimeout(["update-ref", "-d", orphanRef], projectRoot);
      } catch {
        // ref may already be absent
      }
    }

    try {
      // Create worktree with new branch. The branch name and worktree path
      // are routed through the producers above; this call is the only place
      // that names them on the git command line.
      const { exitCode, stderr } = await _worktreeManagerDeps.gitWithTimeout(
        ["worktree", "add", worktreePath, "-b", branchName],
        projectRoot,
      );
      if (exitCode !== 0) {
        throw new NaxError(`Failed to create worktree: ${stderr || "unknown error"}`, "WORKTREE_ERROR", {
          stage: "worktree",
          worktreeId,
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
            worktreeId,
            projectRoot,
          });
        }
        throw new NaxError(error.message, "WORKTREE_ERROR", {
          stage: "worktree",
          worktreeId,
          projectRoot,
          cause: error,
        });
      }
      throw new NaxError(`Failed to create worktree: ${String(error)}`, "WORKTREE_ERROR", {
        stage: "worktree",
        worktreeId,
        projectRoot,
      });
    }

    // Symlink .env if it exists. worktreePath is the producer-derived
    // `<root>/.nax-wt/<worktreeId>`; we don't re-spell it inline.
    const envSource = `${projectRoot}/.env`;
    if (existsSync(envSource)) {
      const envTarget = `${worktreePath}/.env`;
      try {
        symlinkSync(envSource, envTarget, "file");
      } catch (error) {
        // Clean up worktree if symlinking fails
        await this.remove(projectRoot, worktreeId);
        throw new NaxError(`Failed to symlink .env: ${errorMessage(error)}`, "WORKTREE_ERROR", {
          stage: "worktree",
          worktreeId,
          envSource,
          envTarget,
        });
      }
    }
  }

  /**
   * Removes the worktree directory and deletes its branch.
   *
   * US-002 narrows the second parameter to `WorktreeId`. The path and
   * branch are derived through the same producers `create()` uses, so
   * this method spells neither inline.
   */
  async remove(projectRoot: string, worktreeId: WorktreeId): Promise<void> {
    const worktreePath = storyWorktreePath(projectRoot, worktreeId);
    const branchName = storyBranchName(worktreeId);

    // Remove worktree
    try {
      const { exitCode, stderr } = await _worktreeManagerDeps.gitWithTimeout(
        ["worktree", "remove", worktreePath, "--force"],
        projectRoot,
      );
      if (exitCode !== 0) {
        if (
          stderr.includes("not found") ||
          stderr.includes("does not exist") ||
          stderr.includes("no such worktree") ||
          stderr.includes("is not a working tree")
        ) {
          throw new NaxError(`Worktree not found: ${worktreePath}`, "WORKTREE_NOT_FOUND", {
            stage: "worktree",
            worktreeId,
            worktreePath,
          });
        }
        throw new NaxError(`Failed to remove worktree: ${stderr || "unknown error"}`, "WORKTREE_ERROR", {
          stage: "worktree",
          worktreeId,
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
        worktreeId,
        worktreePath,
        cause: error instanceof Error ? error : undefined,
      });
    }

    // Delete branch
    try {
      const { exitCode, stderr } = await _worktreeManagerDeps.gitWithTimeout(["branch", "-D", branchName], projectRoot);
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
      const { stdout, stderr, exitCode } = await _worktreeManagerDeps.gitWithTimeout(
        ["worktree", "list", "--porcelain"],
        projectRoot,
      );
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
