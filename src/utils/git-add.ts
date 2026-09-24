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
 */

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
  const gitlinks = parseGitlinks(listed.stdout);
  const excludes = gitlinks.map((p) => `:(exclude,literal)${p}`);
  const added = await git(["add", ...(opts.flags ?? []), "--", ...pathspecs, ...excludes], cwd, opts.timeoutMs);
  if (added.exitCode !== 0 || gitlinks.length === 0) return added;
  return git(["update-index", "--add", "--remove", "--", ...gitlinks], cwd, opts.timeoutMs);
}
