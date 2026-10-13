/** Shared git plumbing for the reviewer guard (nax#2500): the injectable seam and thin git wrappers. */
import { lstat, rm } from "node:fs/promises";
import { NaxError } from "@/errors";
import { changedPathsBetween, snapshotWorkingTree } from "@/review/fix-review/tree-snapshot";
import { runHardenedGit } from "@/utils/hardened-git";

export const _snapshotDeps = { rm, lstat, snapshotWorkingTree, changedPathsBetween, git: runHardenedGit };

export const STAGE = "reviewer-guard";

export function guardGitError(args: readonly string[], cwd: string, stderr: string): NaxError {
  return new NaxError(`[${STAGE}] git ${args.join(" ")} failed: ${stderr.trim()}`, "REVIEWER_GUARD_GIT_FAILED", {
    stage: STAGE,
    cwd,
  });
}

/** Untrimmed stdout; throws on a non-zero exit unless `allowFail` (then returns ""). */
export async function gitRaw(args: readonly string[], cwd: string, allowFail = false): Promise<string> {
  const r = await _snapshotDeps.git(args, cwd);
  if (r.exitCode !== 0 && !allowFail) throw guardGitError(args, cwd, r.stderr);
  return r.exitCode === 0 ? r.stdout : "";
}

export async function git(args: readonly string[], cwd: string, allowFail = false): Promise<string> {
  return (await gitRaw(args, cwd, allowFail)).trim();
}

/**
 * Symbolic target of HEAD, or undefined when detached. Only exit code 1 means
 * detached; any other failure (timeout, 128) throws so a transient error can
 * never be mistaken for a detached HEAD.
 */
export async function symbolicHead(cwd: string): Promise<string | undefined> {
  const args = ["symbolic-ref", "-q", "HEAD"];
  const r = await _snapshotDeps.git(args, cwd);
  if (r.exitCode === 0) return r.stdout.trim() || undefined;
  if (r.exitCode === 1) return undefined;
  throw guardGitError(args, cwd, r.stderr || `exit ${r.exitCode}`);
}
