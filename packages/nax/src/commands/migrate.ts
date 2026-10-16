/**
 * nax migrate — project-name collision recovery.
 *
 * Two operator modes, both global-state operations keyed on a project name:
 * `--reclaim <name>` archives `~/.nax/<name>/` so the name is free again, and
 * `--merge <name>` repoints that name's stored identity at the current workdir.
 * With neither flag `migrateCommand` refuses with `MIGRATE_NO_MODE`.
 *
 * The module also still carries the generated-content helpers
 * (`detectGeneratedContent`, `partitionTrackedCandidates`,
 * `autoMigrateGeneratedContent`); `migrateCommand` no longer calls them, because
 * moving live in-repo `.nax/` artifacts to the output directory took them away
 * from the readers inside the project.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { gitSpawnEnv } from "@nathapp/nax-agent/internal";
import { validateProjectName } from "../cli/init";
import { globalConfigDir } from "../config/paths";
import { NaxError } from "../errors";
import { getLogger, getSafeLogger } from "../logger";
import { readProjectIdentity, writeProjectIdentity } from "../runtime";
import { gitWithTimeout } from "../utils/git";

/**
 * The git subprocess seam the candidate partition spawns through.
 *
 * Re-exported from `../utils/git` (the same object `gitWithTimeout` uses, not a
 * copy) so tests can observe the single `ls-files` call at this module's own
 * injection point, like every other `_deps` object in `src/commands`.
 *
 * @internal
 */
export { _gitDeps } from "../utils/git";

export interface MigrateCandidate {
  name: string;
  srcPath: string;
}

/**
 * Top-level .nax/ entries that are generated at runtime and should be moved out.
 * Source-controlled entries (config.json, context.md, mono/, features/) are excluded.
 */
const GENERATED_NAMES = new Set([
  "runs",
  "prompt-audit",
  "review-audit",
  "cost",
  "metrics.json",
  "cycle-shadow",
  "curator",
]);

/**
 * Sub-entries inside .nax/features/<id>/ that are generated at runtime.
 */
const GENERATED_FEATURE_SUBNAMES = new Set(["runs", "sessions", "status.json"]);

/**
 * Scan a .nax/ directory and return all generated entries that can be migrated.
 * Returns an empty array if there is nothing to migrate (idempotent: safe to call
 * when already fully migrated).
 */
export async function detectGeneratedContent(naxDir: string): Promise<MigrateCandidate[]> {
  if (!existsSync(naxDir)) return [];

  const candidates: MigrateCandidate[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(naxDir);
  } catch {
    return [];
  }

  // Top-level generated entries
  for (const entry of entries) {
    if (GENERATED_NAMES.has(entry)) {
      candidates.push({ name: entry, srcPath: path.join(naxDir, entry) });
    }
  }

  // Per-feature generated entries under .nax/features/<featureId>/
  const featuresDir = path.join(naxDir, "features");
  if (existsSync(featuresDir)) {
    let featureDirs: string[] = [];
    try {
      featureDirs = await readdir(featuresDir);
    } catch {
      // ok — features dir may be empty or unreadable
    }

    for (const fid of featureDirs) {
      const featureDir = path.join(featuresDir, fid);
      let subEntries: string[] = [];
      try {
        subEntries = await readdir(featureDir);
      } catch {
        continue;
      }

      for (const sub of subEntries) {
        if (GENERATED_FEATURE_SUBNAMES.has(sub)) {
          candidates.push({
            name: path.join("features", fid, sub),
            srcPath: path.join(featureDir, sub),
          });
        }

        // Context manifests inside .nax/features/<id>/stories/<storyId>/
        if (sub === "stories") {
          const storiesDir = path.join(featureDir, "stories");
          let storyDirs: string[] = [];
          try {
            storyDirs = await readdir(storiesDir);
          } catch {
            continue;
          }

          for (const sid of storyDirs) {
            const storyDir = path.join(storiesDir, sid);
            let storyEntries: string[] = [];
            try {
              storyEntries = await readdir(storyDir);
            } catch {
              continue;
            }

            for (const se of storyEntries) {
              if (se.startsWith("context-manifest-") && se.endsWith(".json")) {
                candidates.push({
                  name: path.join("features", fid, "stories", sid, se),
                  srcPath: path.join(storyDir, se),
                });
              }
            }
          }
        }
      }
    }
  }

  return candidates;
}

/**
 * Split migration candidates into the ones git still tracks and the ones it
 * does not.
 *
 * Moving a tracked candidate is undone by the next auto-commit, which logs a
 * per-file restore error and leaves the destination behind — the run then
 * refuses with `MIGRATE_CONFLICT` on the next attempt. Only untracked paths are
 * migratable.
 *
 * A candidate is tracked when a listed path equals `.nax/<name>` or lies under
 * `.nax/<name>/`: the `/` boundary is what keeps a tracked `.nax/runs-archive/`
 * file from marking the `runs` candidate. Any git failure (non-zero exit,
 * timeout, throw, not a repo) leaves every candidate migratable.
 *
 * @internal
 */
export async function partitionTrackedCandidates(
  workdir: string,
  candidates: readonly MigrateCandidate[],
): Promise<{ migratable: MigrateCandidate[]; tracked: MigrateCandidate[] }> {
  const logger = getSafeLogger();
  // A single `ls-files` over the whole .nax/ subtree; output is NUL-separated
  // and paths are relative to `workdir`. Partitioning from a flat listing lets
  // us match `.nax/<name>` and `.nax/<name>/` exactly — a single candidate
  // lookup would still need to walk the tree to handle the directory case.
  let stdout: string;
  try {
    const result = await gitWithTimeout(["ls-files", "-z", "--", ".nax"], workdir);
    if (result.exitCode !== 0) {
      // Non-zero (not a repo, error reading the index, etc.) — leave every
      // candidate migratable so behaviour matches "today's" baseline for any
      // caller that cannot rely on git. Log once at debug so the silent
      // fallback is attributable — the same shape as the thrown branch
      // below, so an operator chasing a `MIGRATE_CONFLICT` on the next run
      // can see why their tracked manifest didn't get skipped this time.
      logger?.debug(
        "migrate",
        "partitionTrackedCandidates: git ls-files returned non-zero, treating all candidates as migratable",
        {
          storyId: "_migrate",
          exitCode: result.exitCode,
          stderr: result.stderr.trim(),
        },
      );
      return { migratable: [...candidates], tracked: [] };
    }
    stdout = result.stdout;
  } catch (err) {
    // Spawn / timeout / hard failure: same shape as the non-zero exit — log
    // once at debug, fall back to "all migratable". The auto helper wraps its
    // own catch above this, so a thrown error here would not be the path the
    // startup flow takes, but the CLI path could still hit it on a hung
    // repository.
    logger?.debug("migrate", "partitionTrackedCandidates: git ls-files failed, treating all candidates as migratable", {
      storyId: "_migrate",
      error: err instanceof Error ? err.message : String(err),
    });
    return { migratable: [...candidates], tracked: [] };
  }

  // Collect every listed path under `.nax/`. A candidate with name `X` is
  // tracked when some listed path equals `.nax/X` OR starts with `.nax/X/`.
  // The `/` boundary is what keeps a tracked `.nax/runs-archive/x.json`
  // (prefix `.nax/runs-archive`) from marking an unrelated `runs` candidate
  // (prefix `.nax/runs`), and what keeps a tracked
  // `.nax/features/f/stories/US-001/...` manifest from marking an untracked
  // `features/g/runs` candidate — they share the top-level `features`
  // segment but the candidate's own prefix doesn't match any listed path.
  const listedPaths: string[] = [];
  for (const listed of stdout.split("\0")) {
    if (!listed || listed === ".nax") continue;
    if (listed.startsWith(".nax/")) listedPaths.push(listed);
  }

  const migratable: MigrateCandidate[] = [];
  const trackedOut: MigrateCandidate[] = [];
  for (const candidate of candidates) {
    // `candidate.name` is built with `path.join`, which on Windows uses
    // backslashes; `git ls-files` always emits POSIX-style paths with forward
    // slashes. Normalise to forward slashes here so the prefix match works on
    // every platform — the comparison-only side has no filesystem effect, so
    // a plain `replace` is safe (no `path.posix` import needed).
    const normalisedName = candidate.name.split("\\").join("/");
    const target = `.nax/${normalisedName}`;
    const targetWithSlash = `${target}/`;
    const isTracked = listedPaths.some((listed) => listed === target || listed.startsWith(targetWithSlash));
    if (isTracked) {
      trackedOut.push(candidate);
    } else {
      migratable.push(candidate);
    }
  }

  return { migratable, tracked: trackedOut };
}

/**
 * Startup auto-migration: move generated `.nax/` content to the output dir,
 * skipping everything git still tracks, and never reject.
 *
 * The partition is shared with the `nax migrate` CLI path, so anything skipped
 * here is skipped there. Since that CLI path no longer performs a move, this
 * helper's own `migrateCommand({ workdir })` call always refuses with
 * `MIGRATE_NO_MODE` and is swallowed by the warn branch below — the tracked
 * classification and its reporting are all this function still contributes.
 *
 * Detection, partition, and `migrateCommand` failures are swallowed: the run
 * must keep going even if `.nax/config.json` is missing or the output dir
 * cannot be written.
 *
 * @internal
 */
export async function autoMigrateGeneratedContent(workdir: string): Promise<void> {
  const logger = getSafeLogger();
  let candidates: MigrateCandidate[];
  try {
    candidates = await detectGeneratedContent(path.join(workdir, ".nax"));
  } catch (err) {
    logger?.debug("migrate", "autoMigrateGeneratedContent: detectGeneratedContent failed, skipping migration", {
      storyId: "_setup",
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (candidates.length === 0) return;

  let partition: { migratable: MigrateCandidate[]; tracked: MigrateCandidate[] };
  try {
    partition = await partitionTrackedCandidates(workdir, candidates);
  } catch (err) {
    logger?.debug(
      "migrate",
      "autoMigrateGeneratedContent: partitionTrackedCandidates failed, treating all candidates as migratable",
      {
        storyId: "_setup",
        error: err instanceof Error ? err.message : String(err),
      },
    );
    partition = { migratable: candidates, tracked: [] };
  }

  const { migratable, tracked } = partition;

  if (tracked.length > 0) {
    // `paths` is the first 5 tracked srcPaths relative to workdir — a
    // relative path is what the operator needs to copy from the warning into
    // their shell. Absolute paths would be wrong and uncopyable across
    // machines.
    const paths = tracked.map((candidate) => path.relative(workdir, candidate.srcPath)).slice(0, 5);
    const firstPath = paths[0];
    if (firstPath !== undefined) {
      logger?.warn("setup", "Skipping git-tracked generated content under .nax/ — untrack it with git rm -r --cached", {
        storyId: "_setup",
        count: tracked.length,
        paths,
        fix: `git rm -r --cached ${firstPath}`,
      });
    }
  }

  if (migratable.length === 0) return;

  logger?.info("setup", "Found generated content under .nax/ — migrating to output dir", {
    storyId: "_setup",
    count: migratable.length,
  });

  try {
    await migrateCommand({ workdir });
    logger?.info("setup", "Auto-migration complete", { storyId: "_setup" });
  } catch (err) {
    logger?.warn("setup", "Auto-migration failed — continuing without migration", {
      storyId: "_setup",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface MigrateOptions {
  workdir: string;
  /** Project name to archive-and-free from ~/.nax/<name>/. */
  reclaim?: string;
  /** Project name to rewrite identity for current workdir. */
  merge?: string;
}

/**
 * Recover a project-name collision: archive the named global project directory
 * (`--reclaim`) or repoint its identity at this workdir (`--merge`).
 *
 * With neither mode set the command refuses with `MIGRATE_NO_MODE` before
 * touching anything. It used to move generated `.nax/` content into the output
 * directory by default, which renamed live in-repo artifacts out from under the
 * readers that need them.
 */
export async function migrateCommand(options: MigrateOptions): Promise<void> {
  const logger = getLogger();

  // --reclaim: archive ~/.nax/<name>/ to ~/.nax/_archive/<name>-<ts>/
  if (options.reclaim) {
    const reclaimValidation = validateProjectName(options.reclaim);
    if (!reclaimValidation.valid) {
      throw new NaxError(
        `Invalid project name "${options.reclaim}": ${reclaimValidation.error}`,
        "MIGRATE_INVALID_NAME",
        {
          stage: "migrate",
          name: options.reclaim,
        },
      );
    }
    const src = path.join(globalConfigDir(), options.reclaim);
    if (!existsSync(src)) {
      throw new NaxError(`Nothing to reclaim: ~/.nax/${options.reclaim} does not exist`, "MIGRATE_RECLAIM_NOT_FOUND", {
        stage: "migrate",
        name: options.reclaim,
      });
    }
    const archiveBase = path.join(globalConfigDir(), "_archive");
    const archiveDest = path.join(archiveBase, `${options.reclaim}-${Date.now()}`);
    await mkdir(archiveBase, { recursive: true });
    await rename(src, archiveDest);
    logger.info("migrate", `Reclaimed: archived to ${archiveDest}`, { storyId: "_migrate" });
    return;
  }

  // --merge: rewrite identity to point to current workdir
  if (options.merge) {
    const mergeValidation = validateProjectName(options.merge);
    if (!mergeValidation.valid) {
      throw new NaxError(`Invalid project name "${options.merge}": ${mergeValidation.error}`, "MIGRATE_INVALID_NAME", {
        stage: "migrate",
        name: options.merge,
      });
    }
    const existing = await readProjectIdentity(options.merge);
    if (!existing) {
      throw new NaxError(`Cannot merge: ~/.nax/${options.merge}/.identity not found`, "MIGRATE_MERGE_NOT_FOUND", {
        stage: "migrate",
        name: options.merge,
      });
    }
    let currentRemote: string | null = null;
    try {
      const gitResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], {
        cwd: options.workdir,
        env: gitSpawnEnv(),
      });
      if (gitResult.exitCode === 0) {
        currentRemote = new TextDecoder().decode(gitResult.stdout).trim() || null;
      }
    } catch {
      /* non-git project */
    }

    await writeProjectIdentity(options.merge, {
      ...existing,
      workdir: options.workdir,
      remoteUrl: currentRemote,
      lastSeen: new Date().toISOString(),
    });
    logger.info("migrate", `Merged: identity for "${options.merge}" updated`, { storyId: "_migrate" });
    return;
  }

  throw new NaxError("nax migrate needs --reclaim <name> or --merge <name>", "MIGRATE_NO_MODE", {
    stage: "migrate",
    workdir: options.workdir,
  });
}
