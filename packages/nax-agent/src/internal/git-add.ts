/**
 * `git add` that never makes git recurse into a gitlink (#2210).
 *
 * For every gitlink (submodule entry) in the index, `git add` runs
 * `git status` inside the nested repository to learn whether it is dirty,
 * and that child git reads the nested repo's own `.git/config` and
 * `.gitattributes`. A nested repo the agent created inside the sandbox write
 * root can name a filter driver there (`filter.<x>.clean`), which nax's
 * unsandboxed `git add` would then run. `add` ignores `diff.ignoreSubmodules`
 * (it overrides submodule config), so the env hardening in `./git-env` cannot
 * reach it. Instead, gitlinks are excluded from the `add` pathspec and
 * restaged with `git update-index`, which records the nested HEAD without
 * spawning git inside it. The staged result is the same as a plain `git add`.
 *
 * `git commit` with nothing staged prints a status, and that status honours a
 * `submodule.<name>.ignore` from `.gitmodules` -- so it can recurse too. The
 * commit sites therefore ask `hasStagedChanges` first and never run a commit
 * that would only report "nothing to commit".
 *
 * US-006: the same `add` also excludes every bwrap placeholder-shaped path nax
 * protects (an empty 0444 `.mcp.json`, `.gitmodules`, a trusted ledger's entry).
 * A broad staging pass used to commit one as an empty file in the user's
 * history; the exclusion is one more `:(exclude,literal)` pathspec, derived from
 * the tracked set this module already lists, so a tree with no placeholder keeps
 * exactly the argv it had.
 */
import { stagingPlaceholderPaths } from "../sandbox/staging-placeholders.ts";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

/** `gitWithTimeout`'s shape; injected so this module does not import `./git` (which imports it). */
export type GitRunner = (args: string[], cwd: string, timeoutMs?: number) => Promise<GitRunResult>;

export interface GitlinkSafeAddOptions {
  /** Flags placed before `--`, e.g. `["-A"]`. */
  readonly flags?: readonly string[];
  /** Pathspecs to stage; empty means the whole tree (`:/`), as a bare `git add -A` does. */
  readonly pathspecs?: readonly string[];
  readonly timeoutMs?: number;
}

const GITLINK_MODE = "160000";
const WHOLE_TREE_PATHSPEC = ":/";

/** Every path in `git ls-files --stage -z` output (paths as git printed them: relative to its cwd). */
function parseTrackedPaths(lsFilesStageZ: string): string[] {
  const paths = lsFilesStageZ.split("\0").flatMap((record) => {
    const tab = record.indexOf("\t");
    return tab < 0 ? [] : [record.slice(tab + 1)];
  });
  return [...new Set(paths)];
}

/** Gitlink paths from `git ls-files --stage -z` output (paths as git printed them: relative to its cwd). */
export function parseGitlinks(lsFilesStageZ: string): string[] {
  const paths = lsFilesStageZ.split("\0").flatMap((record) => {
    const tab = record.indexOf("\t");
    if (tab < 0 || !record.startsWith(`${GITLINK_MODE} `)) return [];
    return [record.slice(tab + 1)];
  });
  // An unmerged gitlink has one entry per stage.
  return [...new Set(paths)];
}

export async function gitlinkSafeAdd(git: GitRunner, cwd: string, opts: GitlinkSafeAddOptions): Promise<GitRunResult> {
  const pathspecs = opts.pathspecs !== undefined && opts.pathspecs.length > 0 ? opts.pathspecs : [WHOLE_TREE_PATHSPEC];
  const listed = await git(["ls-files", "--stage", "-z", "--", ...pathspecs], cwd, opts.timeoutMs);
  if (listed.exitCode !== 0 || listed.timedOut) {
    // Fail closed: staging without knowing the gitlinks would recurse into them.
    return { ...listed, exitCode: listed.exitCode === 0 ? 1 : listed.exitCode };
  }
  const tracked = parseTrackedPaths(listed.stdout);
  const gitlinks = parseGitlinks(listed.stdout);
  const excludes = [
    ...gitlinks.map((p) => `:(exclude,literal)${p}`),
    // US-006: never stage a placeholder-shaped path nax protects. A tree with no
    // placeholder yields no extra pathspec, so that argv is unchanged.
    ...stagingPlaceholderPaths(cwd, tracked).map((p) => `:(exclude,literal)${p}`),
  ];
  const added = await git(["add", ...(opts.flags ?? []), "--", ...pathspecs, ...excludes], cwd, opts.timeoutMs);
  if (added.exitCode !== 0 || gitlinks.length === 0) return added;
  return git(["update-index", "--add", "--remove", "--", ...gitlinks], cwd, opts.timeoutMs);
}

/**
 * Whether the index differs from HEAD: `diff --cached` compares index to HEAD
 * only, so it never looks at the worktree or inside a gitlink. Undefined when
 * git could not answer (fail closed: callers do not commit).
 */
export async function hasStagedChanges(git: GitRunner, cwd: string, timeoutMs?: number): Promise<boolean | undefined> {
  const r = await git(["diff", "--cached", "--quiet"], cwd, timeoutMs);
  if (r.timedOut) return undefined;
  if (r.exitCode === 0) return false;
  return r.exitCode === 1 ? true : undefined;
}
