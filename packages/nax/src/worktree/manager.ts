import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, type Stats, symlinkSync } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import { tryExclusiveCreate } from "../execution/lock";
import { getSafeLogger } from "../logger";
import { gitWithTimeout } from "../utils/git";
import { NAX_GITIGNORE_ENTRIES, NAX_RETIRED_GITIGNORE_ENTRIES } from "../utils/gitignore";
import { naxOrphanRefName } from "./nax-orphan-ref";
import type { WorktreeInfo } from "./types";
import type { WorktreeId } from "./worktree-id";
import { storyBranchName, storyWorktreePath } from "./worktree-id";

/**
 * Injectable seams. Tests stub `gitWithTimeout` to drive `create()` and
 * `remove()` end to end without spawning real git, and `lstatSync` to reach
 * the worktree `.env` inspection failure that no real filesystem state produces.
 *
 * @internal
 */
export const _worktreeManagerDeps = {
  gitWithTimeout,
  lstatSync: (path: string): Stats => lstatSync(path),
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

/**
 * Proof that a caller created a worktree. `create()` returns it; `remove()`
 * given one deletes the tree only while the on-disk owner record still
 * carries the same token, so a stale owner can never remove a successor's tree.
 */
export interface WorktreeAllocation {
  readonly worktreeId: WorktreeId;
  readonly token: string;
}

const OWNER_DIR = "nax-wt-owners";

async function ownerRecordPath(projectRoot: string, worktreeId: WorktreeId): Promise<string> {
  return join(await resolveGitInfoDir(projectRoot), OWNER_DIR, worktreeId);
}

async function readOwnerToken(recordPath: string): Promise<string | null> {
  return Bun.file(recordPath)
    .text()
    .catch(() => null);
}

const NAX_EXCLUDE_HEADER = "# nax — generated files (auto-added by nax parallel)";

interface PreserveEnvOptions {
  projectRoot: string;
  worktreePath: string;
  worktreeId: WorktreeId;
  removeWorktree: () => Promise<void>;
}

/** Keep a checked-out .env or link the project .env when the worktree has no copy. */
async function preserveWorktreeEnv(options: PreserveEnvOptions): Promise<void> {
  const envSource = join(options.projectRoot, ".env");
  if (!existsSync(envSource)) return;

  const envTarget = join(options.worktreePath, ".env");
  try {
    _worktreeManagerDeps.lstatSync(envTarget);
    getSafeLogger()?.debug("worktree", ".env is tracked; the worktree keeps the checked-out copy", {
      worktreeId: options.worktreeId,
    });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await options.removeWorktree();
      throw new NaxError(`Failed to inspect worktree .env: ${errorMessage(error)}`, "WORKTREE_ERROR", {
        stage: "worktree",
        worktreeId: options.worktreeId,
        envTarget,
        cause: error,
      });
    }
  }

  try {
    symlinkSync(envSource, envTarget, "file");
  } catch (error) {
    await options.removeWorktree();
    throw new NaxError(`Failed to symlink .env: ${errorMessage(error)}`, "WORKTREE_ERROR", {
      stage: "worktree",
      worktreeId: options.worktreeId,
      envSource,
      envTarget,
    });
  }
}

/**
 * Drop retired entries line-exactly, keeping every other line (the user's own
 * rules and comments) verbatim. A nax section header left with no rule under
 * it goes too, so repeated reconciles do not pile up empty headers.
 */
function dropRetiredLines(content: string, retired: ReadonlySet<string>): string {
  const lines = content.split("\n").filter((line) => !retired.has(line.trim()));
  const headsEmptySection = (index: number): boolean => {
    const next = lines.slice(index + 1).find((line) => line.trim().length > 0);
    return next === undefined || next.trim() === NAX_EXCLUDE_HEADER;
  };
  return lines.filter((line, index) => line.trim() !== NAX_EXCLUDE_HEADER || !headsEmptySection(index)).join("\n");
}

async function ownsRecord(
  recordPath: string,
  allocation: WorktreeAllocation,
  worktreeId: WorktreeId,
): Promise<boolean> {
  return allocation.worktreeId === worktreeId && (await readOwnerToken(recordPath)) === allocation.token;
}

/** `git worktree add <path> -b <branch>`, mapping failures to WORKTREE_ERROR. */
async function addWorktree(projectRoot: string, worktreeId: WorktreeId): Promise<void> {
  const context = { stage: "worktree", worktreeId, projectRoot };
  try {
    const { exitCode, stderr } = await _worktreeManagerDeps.gitWithTimeout(
      ["worktree", "add", storyWorktreePath(projectRoot, worktreeId), "-b", storyBranchName(worktreeId)],
      projectRoot,
    );
    if (exitCode !== 0) {
      throw new NaxError(`Failed to create worktree: ${stderr || "unknown error"}`, "WORKTREE_ERROR", {
        ...context,
        stderr,
      });
    }
  } catch (error) {
    if (error instanceof NaxError) throw error;
    if (error instanceof Error && error.message.includes("not a git repository")) {
      throw new NaxError(`Not a git repository: ${projectRoot}`, "WORKTREE_ERROR", context);
    }
    const message = error instanceof Error ? error.message : `Failed to create worktree: ${String(error)}`;
    throw new NaxError(message, "WORKTREE_ERROR", { ...context, ...(error instanceof Error ? { cause: error } : {}) });
  }
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

      const { withPathFileLock } = await import("@nathapp/nax-agent/internal");
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
        const retired = new Set<string>(NAX_RETIRED_GITIGNORE_ENTRIES.filter((entry) => existingLines.has(entry)));
        if (missing.length === 0 && retired.size === 0) return;

        const kept = retired.size === 0 ? existing : dropRetiredLines(existing, retired);
        const section = missing.length === 0 ? "" : `\n${NAX_EXCLUDE_HEADER}\n${missing.join("\n")}\n`;
        await Bun.write(excludePath, kept + section);

        logger?.info("worktree", "Updated .git/info/exclude with nax entries", {
          added: missing.length,
          removed: retired.size,
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
  async create(projectRoot: string, worktreeId: WorktreeId): Promise<WorktreeAllocation> {
    // Serialize competing creates for one ID: the loser sees the winner's tree
    // and refuses instead of racing it into git.
    const { withPathFileLock } = await import("@nathapp/nax-agent/internal");
    const lockTarget = join(await resolveGitInfoDir(projectRoot), `${OWNER_DIR}.${worktreeId}`);
    await mkdir(join(lockTarget, ".."), { recursive: true });
    return withPathFileLock(lockTarget, () => this.createExclusive(projectRoot, worktreeId));
  }

  private async createExclusive(projectRoot: string, worktreeId: WorktreeId): Promise<WorktreeAllocation> {
    const worktreePath = storyWorktreePath(projectRoot, worktreeId);

    // A live tree at this path is never replaced: refuse before mutating any
    // Git state so the occupant's working files and branch tip stay intact.
    if (existsSync(worktreePath)) {
      throw new NaxError(`Worktree path is already occupied: ${worktreePath}`, "WORKTREE_OCCUPIED", {
        stage: "worktree",
        worktreeId,
        projectRoot,
        worktreePath,
      });
    }

    await this.reclaimOrphanBranch(projectRoot, worktreeId);

    const recordPath = await ownerRecordPath(projectRoot, worktreeId);
    await mkdir(join(recordPath, ".."), { recursive: true });
    const token = randomUUID();
    // The tree path is free (checked above), so any existing record is a dead
    // allocation's; replace it.
    await unlink(recordPath).catch(() => {});
    if (!(await tryExclusiveCreate(recordPath, token))) {
      throw new NaxError(`Worktree allocation is contested: ${worktreePath}`, "WORKTREE_OCCUPIED", {
        stage: "worktree",
        worktreeId,
        projectRoot,
        worktreePath,
      });
    }
    const allocation: WorktreeAllocation = { worktreeId, token };

    try {
      await addWorktree(projectRoot, worktreeId);
    } catch (error) {
      if ((await readOwnerToken(recordPath)) === token) await unlink(recordPath).catch(() => {});
      throw error;
    }

    // Keep a checked-out .env or mirror an ignored one into the new worktree.
    await preserveWorktreeEnv({
      projectRoot,
      worktreePath,
      worktreeId,
      removeWorktree: () => this.remove(projectRoot, worktreeId, allocation),
    });
    return allocation;
  }

  /**
   * Branch-only orphan recovery (BUG-28 / US-002). The tree directory is known
   * to be gone; a leftover branch is force-deleted only when a prior nax
   * worktree record or a `refs/nax/orphan/<id>` ref proves nax created it. A
   * user branch of the same name has neither and is never deleted.
   */
  private async reclaimOrphanBranch(projectRoot: string, worktreeId: WorktreeId): Promise<void> {
    const branchName = storyBranchName(worktreeId);
    const orphanRef = naxOrphanRefName(worktreeId);
    const hadWorktreeRecord = await this.hasWorktreeRecord(projectRoot, branchName);
    const hadNaxOwnershipRecord = await this.hasNaxOwnershipRecord(projectRoot, worktreeId);
    const orphanCommit = hadNaxOwnershipRecord ? await this.resolveGitRef(projectRoot, orphanRef) : undefined;
    const branchRef = `refs/heads/${branchName}`;
    const branchCommit = await this.resolveGitRef(projectRoot, branchRef);
    const orphanMatchesBranch = orphanCommit !== undefined && orphanCommit === branchCommit;

    // Prune admin refs whose directories no longer exist (best-effort; BUG-5 timeout).
    await _worktreeManagerDeps.gitWithTimeout(["worktree", "prune"], projectRoot).catch(() => undefined);

    let clearedBranch = false;
    if (hadWorktreeRecord || orphanMatchesBranch) {
      const args = orphanMatchesBranch
        ? ["update-ref", "-d", branchRef, orphanCommit as string]
        : ["branch", "-D", branchName];
      const result = await _worktreeManagerDeps.gitWithTimeout(args, projectRoot).catch(() => undefined);
      clearedBranch = result?.exitCode === 0;
    }

    // The orphan record must not outlive what it records; keep it only when the
    // branch it describes survived a failed delete.
    if (hadNaxOwnershipRecord && (clearedBranch || !orphanMatchesBranch)) {
      await _worktreeManagerDeps.gitWithTimeout(["update-ref", "-d", orphanRef], projectRoot).catch(() => undefined);
    }
  }

  /**
   * Removes the worktree directory and deletes its branch.
   *
   * US-002 narrows the second parameter to `WorktreeId`. The path and
   * branch are derived through the same producers `create()` uses, so
   * this method spells neither inline.
   */
  async remove(projectRoot: string, worktreeId: WorktreeId, allocation?: WorktreeAllocation): Promise<void> {
    const worktreePath = storyWorktreePath(projectRoot, worktreeId);
    const branchName = storyBranchName(worktreeId);

    // With an allocation, remove only what that allocation still owns.
    const recordPath = allocation === undefined ? undefined : await ownerRecordPath(projectRoot, worktreeId);
    if (
      allocation !== undefined &&
      recordPath !== undefined &&
      !(await ownsRecord(recordPath, allocation, worktreeId))
    ) {
      getSafeLogger()?.warn("worktree", "Not removing worktree: allocation no longer owns it", { worktreeId });
      return;
    }

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

    if (recordPath !== undefined) await unlink(recordPath).catch(() => {});

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
