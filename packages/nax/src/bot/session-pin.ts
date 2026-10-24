import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "../errors";
import { botGit } from "./git";
import { isPinnedPath } from "./path-policy";

export const _sessionPinDeps = {
  runGit: botGit,
  rm: (path: string) => rm(path, { recursive: true, force: true }),
  lstat,
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

async function restorePinned(worktree: string, paths: readonly string[]): Promise<void> {
  const git = sessionGit(worktree, "BOT_SESSION_RESTORE_FAILED");
  if (paths.length) await git(["update-index", "--no-skip-worktree", "--", ...paths]);
  await pathCommand(git, ["reset", "-q", "HEAD"], paths);
  for (const path of paths) await _sessionPinDeps.rm(join(worktree, path));
  const current = await pinnedFiles(git, "HEAD");
  await pathCommand(git, ["checkout", "HEAD"], current);
}

/** Temporarily load base agent config without staging it in the session's commits. */
export async function pinBaseForSession(worktree: string, baseSha: string): Promise<SessionPin> {
  const git = sessionGit(worktree, "BOT_SESSION_PIN_FAILED");
  const head = await pinnedFiles(git, "HEAD");
  const base = await pinnedFiles(git, baseSha);
  const paths = [...new Set([...head, ...base])];
  const headSet = new Set(head);
  const baseOnly = base.filter((path) => !headSet.has(path));
  for (const path of head) await _sessionPinDeps.rm(join(worktree, path));
  await pathCommand(git, ["checkout", baseSha], base);
  await pathCommand(git, ["reset", "-q", "HEAD"], paths);
  // Intent-to-add makes base-only files eligible for skip-worktree without staging their content.
  await pathCommand(git, ["add", "-N"], baseOnly);
  if (paths.length) await git(["update-index", "--skip-worktree", "--", ...paths]);
  return { paths, restore: () => restorePinned(worktree, paths) };
}
