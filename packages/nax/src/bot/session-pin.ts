import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { botGit } from "./git";
import { isPinnedPath } from "./path-policy";

export const _sessionPinDeps = {
  runGit: botGit,
  rm: (path: string) => rm(path, { recursive: true, force: true }),
  lstat,
  getLogger: getSafeLogger,
};

export interface SessionPin {
  /** Repo-relative pinned files touched: head copies removed, base copies written. */
  readonly paths: readonly string[];
  /** Put the current HEAD's pinned files back; clears skip-worktree. */
  restore(): Promise<void>;
}

type GitCall = (args: string[]) => Promise<string>;

function sessionGit(worktree: string, code: string): GitCall {
  return async (args) => {
    try {
      const result = await _sessionPinDeps.runGit(args, worktree);
      if (result.exitCode !== 0) {
        throw new NaxError(`[bot-fix] Git ${args[0]} failed in ${worktree}: ${result.stderr}`, code, {
          stage: "bot-fix",
          worktree,
          args,
          exitCode: result.exitCode,
        });
      }
      return result.stdout;
    } catch (cause) {
      if (cause instanceof NaxError && cause.code === code) throw cause;
      throw new NaxError(`[bot-fix] Git ${args[0]} failed in ${worktree}`, code, {
        stage: "bot-fix",
        worktree,
        args,
        cause,
      });
    }
  };
}

async function pinnedFiles(git: GitCall, ref: string): Promise<string[]> {
  return (await git(["ls-tree", "-r", "--name-only", "-z", ref])).split("\0").filter(isPinnedPath);
}

async function pathCommand(git: GitCall, args: string[], paths: readonly string[]): Promise<void> {
  if (paths.length) await git([...args, "--", ...paths.map((path) => `:(literal)${path}`)]);
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}

/** Inspect parents from the root down: never lstat through a previously found link or file. */
async function safeParents(worktree: string, path: string): Promise<boolean> {
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    try {
      const stat = await _sessionPinDeps.lstat(join(worktree, ...parts.slice(0, i)));
      if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
    } catch (cause) {
      if (hasErrorCode(cause, "ENOENT")) return true; // Missing parents may be created by checkout.
      if (!hasErrorCode(cause, "ENOTDIR")) throw cause;
    }
    _sessionPinDeps
      .getLogger()
      ?.warn("bot-fix", "Skipped pinning a path under a linked or non-directory parent", { path });
    return false;
  }
  return true;
}

async function safePaths(worktree: string, paths: readonly string[]): Promise<string[]> {
  const safe: string[] = [];
  for (const path of paths) if (await safeParents(worktree, path)) safe.push(path);
  return safe;
}

async function removePinned(worktree: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if (!(await safeParents(worktree, path))) continue;
    try {
      await _sessionPinDeps.rm(join(worktree, path));
    } catch (cause) {
      if (!hasErrorCode(cause, "ENOENT") && !hasErrorCode(cause, "ENOTDIR")) throw cause;
    }
  }
}

async function restorePinned(worktree: string, paths: readonly string[]): Promise<void> {
  const git = sessionGit(worktree, "BOT_SESSION_RESTORE_FAILED");
  if (paths.length) await git(["update-index", "--no-skip-worktree", "--", ...paths]);
  await pathCommand(git, ["reset", "-q", "HEAD"], paths);
  await removePinned(worktree, paths);
  const current = await safePaths(worktree, await pinnedFiles(git, "HEAD"));
  await pathCommand(git, ["checkout", "HEAD"], current);
}

async function assertOnlyPinnedChanges(git: GitCall, worktree: string, pinned: readonly string[]): Promise<void> {
  const allowed = new Set(pinned);
  const paths = (await git(["diff", "--cached", "--name-only", "-z", "--no-renames"]))
    .split("\0")
    .filter((path) => path !== "" && !allowed.has(path));
  if (paths.length) {
    throw new NaxError(`[bot-fix] Session pin left staged changes in ${worktree}`, "BOT_SESSION_PIN_FAILED", {
      stage: "bot-fix",
      worktree,
      paths,
    });
  }
}

/** Temporarily load base agent config without staging it in the session's commits. */
export async function pinBaseForSession(worktree: string, baseSha: string): Promise<SessionPin> {
  const git = sessionGit(worktree, "BOT_SESSION_PIN_FAILED");
  const head = await safePaths(worktree, await pinnedFiles(git, "HEAD"));
  const base = await safePaths(worktree, await pinnedFiles(git, baseSha));
  const paths = [...new Set([...head, ...base])];
  const headSet = new Set(head);
  const baseOnly = base.filter((path) => !headSet.has(path));
  await removePinned(worktree, head);
  await pathCommand(git, ["checkout", baseSha], base);
  // Check before reset: a directory pathspec can unstage collateral deletions,
  // leaving them in the worktree for the agent's next add -A to stage again.
  if (paths.length) await assertOnlyPinnedChanges(git, worktree, paths);
  await pathCommand(git, ["reset", "-q", "HEAD"], paths);
  // Force only base-tracked paths: HEAD's ignore rules must not prevent index isolation.
  // Intent-to-add makes base-only files eligible for skip-worktree without staging their content.
  await pathCommand(git, ["add", "-N", "-f"], baseOnly);
  if (paths.length) await git(["update-index", "--skip-worktree", "--", ...paths]);
  return { paths, restore: () => restorePinned(worktree, paths) };
}

async function restoreSession(worktree: string, pin: SessionPin): Promise<void> {
  try {
    await pin.restore();
  } catch (error) {
    _sessionPinDeps.getLogger()?.warn("bot-fix", "Could not restore head agent configuration after the fix session", {
      worktree,
      error: errorMessage(error),
    });
    throw error;
  }
}

/** Pin -> run -> restore. A failed restore discards the result, even when run also failed. */
export function basePinScope(worktree: string, baseSha: string): <T>(run: () => Promise<T>) => Promise<T> {
  return async <T>(run: () => Promise<T>): Promise<T> => {
    const pin = await pinBaseForSession(worktree, baseSha);
    try {
      return await run();
    } finally {
      await restoreSession(worktree, pin);
    }
  };
}
