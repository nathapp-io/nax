/**
 * US-003 — source/control classification for the non-blocking fix (NBF) keep gate.
 *
 * `createMeasureSourceDiff` classifies every path in the pass's diff against the
 * adversarial-passed ref: `.nax` control files are reported separately FIRST
 * (they must never be kept, and must not inflate the source metrics), then test
 * files are excluded (ADR-009 SSOT), and every remaining path lands in exactly
 * one of added / modified / deleted. The `.nax` check leads because a feature's
 * tracked acceptance test (`.nax/features/<f>/.nax-acceptance.test.ts`, #2266)
 * matches a root-anchored test glob such as `**\/*.test.ts`. `git diff` cannot see untracked paths, so
 * untracked files under `.nax/` are collected separately — otherwise a control
 * file the pass CREATED would be invisible. `listCommitsSince` names the commits
 * a restore is about to discard. Split out of `non-blocking-fix.ts` to keep that
 * module under the file-size limit.
 */

import { gitSpawnEnv, hardenedGitArgv, typedSpawn } from "@nathapp/nax-agent/internal";
import type { TestPatternConfig } from "../config/selectors";
import { NaxError } from "../errors";
import { createTestFileClassifier, resolveTestFilePatterns } from "../test-runners";
import { packageDirRelative } from "../utils/paths";

/** Changed paths, repo-root-relative, as `git diff` prints them. */
export interface SourceDiffPaths {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
}

/**
 * How many entries of each path list a diagnostic log carries. The full count
 * is logged beside the capped sample (`addedCount` / `controlPathCount` / …) so
 * a 211-file pass never dwarfs the rest of the JSONL record.
 */
export const NBF_LOGGED_PATH_LIMIT = 20;

/**
 * Source-only diff metrics. Test files must already be excluded by the
 * `measureSourceDiff` implementation (e.g. via `resolveTestFilePatterns`).
 *
 * `paths` and `controlPaths` are optional so a custom `measureSourceDiff`
 * (and existing test doubles) keep working — absent is treated as empty.
 */
export interface SourceDiffMetrics {
  /** Number of changed source files (test files already excluded). */
  fileCount: number;
  /** Total added source lines across those files (test files already excluded). */
  sourceLineCount: number;
  /** Classification of the changed source paths, per `git diff` status. */
  paths?: SourceDiffPaths;
  /**
   * Changed paths under `.nax/` — nax's own control files. They are excluded
   * from `fileCount` / `sourceLineCount` but their presence forces a restore.
   */
  controlPaths?: readonly string[];
}

export const _nonBlockingFixDeps = {
  spawn: typedSpawn,
  resolveTestFilePatterns,
};

/**
 * Run one nax-spawned git command, returning its stdout. Every git argv here
 * goes through `hardenedGitArgv` / `gitSpawnEnv`, matching the rest of `src/`.
 * A non-zero exit rejects with a `NaxError` naming the command.
 */
async function runGitStdout(argv: readonly string[], workdir: string, label: string, code: string): Promise<string> {
  const proc = _nonBlockingFixDeps.spawn(hardenedGitArgv(argv), {
    cwd: workdir,
    env: gitSpawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    const detail = stderr.trim() || `exit ${exitCode}`;
    throw new NaxError(`[non-blocking-fix] ${label} failed: ${detail}`, code, { stage: "execution", workdir, detail });
  }
  return stdout;
}

/**
 * SHAs committed in `workdir` since `ref`, newest first (`git rev-list` order).
 * Default `NonBlockingFixDeps.listCommitsSince`; a non-zero exit rejects.
 */
export async function listCommitsSince(workdir: string, ref: string): Promise<string[]> {
  const stdout = await runGitStdout(
    // nax-git-env-allow: runGitStdout hardens via hardenedGitArgv + gitSpawnEnv
    ["git", "rev-list", `${ref}..HEAD`],
    workdir,
    `git rev-list ${ref}..HEAD`,
    "GIT_REV_LIST_FAILED",
  );
  return stdout.trim().split("\n").filter(Boolean);
}

interface CreateMeasureSourceDiffArgs {
  config: TestPatternConfig;
  projectDir: string;
  packageDir: string;
}

export function createMeasureSourceDiff(
  args: CreateMeasureSourceDiffArgs,
): (workdir: string, fromRef: string) => Promise<SourceDiffMetrics> {
  const packageDirRel = packageDirRelative(args.projectDir, args.packageDir);
  return async (workdir: string, fromRef: string): Promise<SourceDiffMetrics> => {
    const resolved = await _nonBlockingFixDeps.resolveTestFilePatterns(args.config, args.projectDir, packageDirRel);
    const isTestFile = createTestFileClassifier(resolved);

    const numstat = await runGitStdout(
      // nax-git-env-allow: runGitStdout hardens via hardenedGitArgv + gitSpawnEnv
      ["git", "diff", "--numstat", fromRef],
      workdir,
      `git diff --numstat ${fromRef}`,
      "GIT_DIFF_NUMSTAT_FAILED",
    );
    // Added-line counts, keyed by the repo-root-relative path git prints.
    const addedLines = new Map<string, number>();
    for (const line of numstat.trim().split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const filePath = parts[parts.length - 1];
      if (!filePath) continue;
      const added = Number.parseInt(parts[0] ?? "", 10);
      addedLines.set(filePath, Number.isFinite(added) ? added : 0);
    }

    // `--name-status` is the classification source: A → added, D → deleted, and
    // everything else (M/T/R/C/U/X) → modified. A rename/copy is reported under
    // its destination path.
    const nameStatus = await runGitStdout(
      // nax-git-env-allow: runGitStdout hardens via hardenedGitArgv + gitSpawnEnv
      ["git", "diff", "--name-status", fromRef],
      workdir,
      `git diff --name-status ${fromRef}`,
      "GIT_DIFF_NAME_STATUS_FAILED",
    );

    const paths: { added: string[]; modified: string[]; deleted: string[] } = {
      added: [],
      modified: [],
      deleted: [],
    };
    const controlPaths: string[] = [];
    let sourceLineCount = 0;

    for (const line of nameStatus.trim().split("\n").filter(Boolean)) {
      const parts = line.split("\t");
      const status = parts[0] ?? "";
      const filePath = parts[parts.length - 1];
      if (!filePath) continue;
      // A `.nax` control file is neither source nor a change to keep: it buys no
      // count, but its presence (see `runNonBlockingFix`) forces a restore.
      // Checked before the test exclusion -- see the module header.
      if (filePath.split("/")[0] === ".nax") {
        controlPaths.push(filePath);
        continue;
      }
      if (isTestFile(filePath)) continue;
      if (status.startsWith("A")) paths.added.push(filePath);
      else if (status.startsWith("D")) paths.deleted.push(filePath);
      else paths.modified.push(filePath);
      sourceLineCount += addedLines.get(filePath) ?? 0;
    }

    // `git diff` reports no untracked path at all, so a `.nax` control file the
    // pass CREATED would otherwise be invisible and the pass kept on a within-cap
    // tracked diff. `--exclude-standard` mirrors the untracked view
    // `rollbackToRef` cleans (it reads `git status --porcelain`), so every path
    // listed here is one a restore can actually remove.
    const untracked = await runGitStdout(
      // nax-git-env-allow: runGitStdout hardens via hardenedGitArgv + gitSpawnEnv
      ["git", "ls-files", "--others", "--exclude-standard", "--", ".nax"],
      workdir,
      "git ls-files --others --exclude-standard -- .nax",
      "GIT_LS_FILES_UNTRACKED_FAILED",
    );
    // Every path here is under `.nax`, so each is a control path -- a test file
    // included, for the same reason as above.
    controlPaths.push(...untracked.trim().split("\n").filter(Boolean));

    const fileCount = paths.added.length + paths.modified.length + paths.deleted.length;
    return { fileCount, sourceLineCount, paths, controlPaths };
  };
}
