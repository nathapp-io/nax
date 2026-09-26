/**
 * Working-tree snapshot helpers for the scoped fix review (US-002).
 *
 * The scoped fix review (ADR-033) judges only what a fix pass changed *in the
 * working tree*, and neither existing collector can say that: the diff helpers
 * in `src/review/diff-utils.ts` are hard-wired to `<ref>..HEAD`, while
 * `captureWorkingTreeChanges` (`src/utils/git.ts`) collapses every git failure
 * to `[]` and lists every untracked file, pre-existing ones included.
 *
 * Contract (US-002):
 * - `snapshotWorkingTree` — tree id of the current working tree (tracked +
 *   untracked, `.gitignore` honoured). Mutates nothing: the repository's own
 *   index and working tree are exactly as they were found, so a caller can
 *   snapshot a tree that already holds staged changes.
 * - `changedPathsBetween` — repo-root-relative paths that differ between two
 *   tree-ishes, with no rename detection.
 * - `diffBetween` — unified diff between two tree-ishes, excluding paths under
 *   `.nax/`.
 * - All three throw `NaxError` with code `FIX_REVIEW_GIT_FAILED` on a non-zero
 *   git exit, so an empty result can never mean "git failed".
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NaxError } from "@/errors";
import { type SpawnOptions, type SpawnResult, typedSpawn } from "@/utils/bun-deps";
import { gitlinkSafeAdd } from "@/utils/git-add";
import { gitSpawnEnv, hardenedGitArgv } from "@/utils/git-env";

/**
 * `diffBetween` pathspecs: the whole tree, minus every `.nax/` directory. All
 * three are anchored at the repo top (`:/`, `top` magic), so the diff is the
 * same whatever the cwd, matching the repo-wide `changedPathsBetween`.
 */
const DIFF_PATHSPECS = [":/", ":(top,exclude).nax", ":(top,glob,exclude)**/.nax/**"] as const;

/** A git object id: 40 hex (SHA-1) or 64 hex (SHA-256 repositories). */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Injectable spawn seam — mirrors `_gitDeps.spawn` (`src/utils/git.ts`) and
 * the `_forgeDeps` (`src/forge/deps.ts`) pattern so a unit test can pin the
 * `Bun.spawn` calls without `mock.module()`.
 *
 * `mkdtemp` / `rm` are also injectable so the temporary-index cleanup can be
 * asserted in tests that verify the index is gone after `snapshotWorkingTree`.
 */
export interface TreeSnapshotDeps {
  readonly spawn: (cmd: string[], opts: SpawnOptions) => SpawnResult;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly rm: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  readonly tmpdir: () => string;
}

export const _treeSnapshotDeps: TreeSnapshotDeps = {
  spawn: typedSpawn,
  mkdtemp,
  rm,
  tmpdir,
};

/** Result of running a single git invocation. */
interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a git subcommand by its argv (no `git` prefix — the helper prepends
 * `git` so the `["git", ...]` literal only appears at the actual spawn site,
 * where the `check:git-spawn-env` gate expects it). stdout and stderr are
 * drained concurrently with `proc.exited` so a process that fills either
 * pipe's OS buffer before being read would not deadlock the snapshot.
 *
 * `indexOverlay` carries the optional `GIT_INDEX_FILE` pointer — `undefined`
 * for the diff/changed-paths helpers, the temp index path for the snapshot.
 * The overlay is passed through `gitSpawnEnv(...)` so the env var reaches
 * git AND the hardened entries are appended (#2198, defence in depth).
 */
async function runGit(
  args: readonly string[],
  cwd: string,
  indexOverlay?: { GIT_INDEX_FILE: string },
): Promise<GitRunResult> {
  const proc = _treeSnapshotDeps.spawn(hardenedGitArgv(["git", ...args]), {
    cwd,
    env: gitSpawnEnv(indexOverlay),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

/** Stage prefix for the temporary GIT_INDEX_FILE the snapshot helper writes. */
const TEMP_INDEX_PREFIX = "nax-fix-review-snapshot-";

/**
 * Throw a `FIX_REVIEW_GIT_FAILED` error carrying the failing subcommand,
 * cwd, exit status, and stderr tail. The `[stage]` prefix in the message
 * matches the project convention (`[stage]` identifier style), and the
 * context carries the structured fields the operator triages from.
 */
function gitFailed(stage: string, args: readonly string[], cwd: string, detail: string): never {
  throw new NaxError(`[${stage}] git ${args.join(" ")} failed in ${cwd}: ${detail}`, "FIX_REVIEW_GIT_FAILED", {
    stage,
    cwd,
    args: [...args],
    detail,
  });
}

/**
 * Tree id of the current working tree (tracked + untracked, `.gitignore` honoured).
 *
 * The implementation seeds a throwaway `GIT_INDEX_FILE` from HEAD, runs a
 * gitlink-safe `git add -A` against it (which respects `.gitignore`), and writes the resulting
 * tree. The repository's own `.git/index` and working tree are untouched:
 * `GIT_INDEX_FILE` redirects git to the throwaway index for the duration of
 * the call. The temp directory is deleted before this function returns, so
 * the only filesystem trace is the tree id.
 */
export async function snapshotWorkingTree(workdir: string): Promise<string> {
  const stage = "fix-review-tree-snapshot";

  const tempDir = await _treeSnapshotDeps.mkdtemp(join(_treeSnapshotDeps.tmpdir(), TEMP_INDEX_PREFIX));
  const tempIndex = join(tempDir, "index");
  // GIT_INDEX_FILE is the overlay `gitSpawnEnv` documents as the intended
  // use for this layer (#2198) — it lets git operate against the throwaway
  // index without touching the repo's real one.
  const indexOverlay = { GIT_INDEX_FILE: tempIndex };

  try {
    // Seed the throwaway index from HEAD — `git read-tree HEAD` writes the
    // current HEAD's tree into GIT_INDEX_FILE without touching the real one.
    // A non-zero exit here is the "not a git repo" case (AC9), so the error
    // message preserves the verbatim stderr.
    const seed = await runGit(["read-tree", "HEAD"], workdir, indexOverlay);
    if (seed.exitCode !== 0)
      gitFailed(stage, ["read-tree", "HEAD"], workdir, seed.stderr.trim() || `exit ${seed.exitCode}`);

    // `git add -A` against the throwaway index: updates tracked entries to
    // their current working-tree content AND stages any new non-ignored files,
    // honouring `.gitignore`. It goes through `gitlinkSafeAdd` because a plain
    // `add` dirty-checks every gitlink by running git inside the nested repo,
    // which would run a filter driver that repo's own config names (#2210).
    // Gitlinks are restaged via `update-index` instead, recording the nested
    // HEAD exactly as a plain `add` would.
    const add = await gitlinkSafeAdd((args, cwd) => runGit(args, cwd, indexOverlay), workdir, { flags: ["-A"] });
    if (add.exitCode !== 0) gitFailed(stage, ["add", "-A"], workdir, add.stderr.trim() || `exit ${add.exitCode}`);

    // `git write-tree` reads the throwaway index and emits its tree id.
    // Output goes to stdout; trailing newline trimmed. The empty-tree case
    // (an index with no entries) would still produce a valid object id, and
    // a fresh repo with no commits is already rejected at `read-tree HEAD`.
    const write = await runGit(["write-tree"], workdir, indexOverlay);
    if (write.exitCode !== 0)
      gitFailed(stage, ["write-tree"], workdir, write.stderr.trim() || `exit ${write.exitCode}`);

    const tree = write.stdout.trim();
    if (!OBJECT_ID.test(tree)) {
      gitFailed(stage, ["write-tree"], workdir, `unexpected tree id: ${tree}`);
    }
    return tree;
  } finally {
    // Best-effort cleanup — a leftover temp dir on disk is not a correctness
    // issue (the repo's own index is untouched), but `os.tmpdir()` would
    // accumulate one per snapshot call otherwise. `fs.rm` on a directory is
    // non-recursive by default and rejects `ERR_FS_EISDIR`, so the temp dir
    // (which holds the throwaway `index`) must be removed with `recursive`.
    await _treeSnapshotDeps.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Repo-root-relative paths that differ between two tree-ishes (no rename detection).
 *
 * A tree-to-tree `git diff --name-only` is not limited by the cwd, so from a
 * package `workdir` it still lists every changed path in the repo, relative to
 * the repo root. `-z` makes git print each path verbatim, NUL-terminated: no
 * C-quoting of non-ASCII names, and no line splitting that would break on a
 * newline or strip surrounding spaces.
 */
export async function changedPathsBetween(workdir: string, from: string, to: string): Promise<string[]> {
  const stage = "fix-review-changed-paths";
  const args = ["diff", "--name-only", "-z", "--no-renames", from, to];
  const result = await runGit(args, workdir);
  if (result.exitCode !== 0) gitFailed(stage, args, workdir, result.stderr.trim() || `exit ${result.exitCode}`);
  // An empty stdout means `from` and `to` describe the same tree — NOT "git
  // failed"; the non-zero exit above already covers that case.
  return result.stdout.split("\0").filter((path) => path.length > 0);
}

/**
 * Unified diff between two tree-ishes, excluding every `.nax/` directory.
 *
 * Repo-wide like `changedPathsBetween`, so the diff the reviewer reads covers
 * exactly the files the scope check judged. A cwd-scoped diff from a package
 * workdir would hide an out-of-package change the scope check had allowed.
 */
export async function diffBetween(workdir: string, from: string, to: string): Promise<string> {
  const stage = "fix-review-diff";
  const args = ["diff", from, to, "--", ...DIFF_PATHSPECS];
  const result = await runGit(args, workdir);
  if (result.exitCode !== 0) gitFailed(stage, args, workdir, result.stderr.trim() || `exit ${result.exitCode}`);
  return result.stdout;
}
