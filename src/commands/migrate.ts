/**
 * nax migrate — moves generated content out of .nax/ into the output directory.
 *
 * Generated artefacts (runs/, metrics.json, prompt-audit/, etc.) accumulate under
 * .nax/ in legacy installations. This command moves them to ~/.nax/<projectKey>/
 * (or the path configured in outputDir) so that .nax/ can be treated as input-only
 * and checked into version control safely.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { validateProjectName } from "../cli/init";
import { globalConfigDir } from "../config/paths";
import { NaxError } from "../errors";
import { getLogger, getSafeLogger } from "../logger";
import { projectOutputDir, readProjectIdentity, writeProjectIdentity } from "../runtime";
import { gitWithTimeout } from "../utils/git";
import { gitSpawnEnv } from "../utils/git-env";

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
 * The full-migration CLI path uses the same partition, so anything moved
 * here is moved by `nax migrate` too — and anything skipped here is skipped
 * there. The two paths only differ in their reporting (auto logs the
 * tracked-content warn and never rejects; CLI logs a per-candidate info line
 * for each skip and lets `migrateCommand`'s existing error semantics stand).
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
  /** When true, log intended moves without touching the filesystem. */
  dryRun?: boolean;
  /** Project name to archive-and-free from ~/.nax/<name>/. */
  reclaim?: string;
  /** Project name to rewrite identity for current workdir. */
  merge?: string;
}

/**
 * Execute the migration: move generated content from .nax/ to the output directory.
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

  const naxDir = path.join(options.workdir, ".nax");

  const configPath = path.join(naxDir, "config.json");
  if (!existsSync(configPath)) {
    throw new NaxError("No .nax/config.json found — run nax init first", "MIGRATE_NO_CONFIG", {
      stage: "migrate",
      workdir: options.workdir,
    });
  }

  let config: { name?: string; outputDir?: string } = {};
  try {
    config = await Bun.file(configPath).json();
  } catch (e) {
    throw new NaxError("Failed to read .nax/config.json", "MIGRATE_CONFIG_READ_FAILED", {
      stage: "migrate",
      cause: e,
    });
  }

  const projectKey = config.name?.trim() || path.basename(options.workdir);
  const destBase = projectOutputDir(projectKey, config.outputDir);
  const candidates = await detectGeneratedContent(naxDir);

  // US-003: git-tracked generated content cannot be moved out of .nax/ — the
  // next auto-commit would restore it, log a per-file error, and leave the
  // destination behind. Partition here so the CLI path matches the startup
  // helper; tracked candidates are surfaced per-file, migratable ones are moved
  // (or reported as moves, under --dry-run).
  const { migratable, tracked } = await partitionTrackedCandidates(options.workdir, candidates);

  if (candidates.length === 0) {
    logger.info("migrate", "Nothing to migrate — already up to date", { storyId: "_migrate" });
    return;
  }

  if (migratable.length === 0) {
    // Every candidate was tracked — log each skip so the operator sees which
    // paths the migration refused, then return. No `Nothing to migrate` line
    // here: there IS something to migrate, the repo just blocks it.
    for (const c of tracked) {
      const rel = path.relative(options.workdir, c.srcPath);
      const msg = options.dryRun ? `[dry-run] Skip (git-tracked): ${rel}` : `Skipping git-tracked: ${rel}`;
      logger.info("migrate", msg, { storyId: "_migrate" });
    }
    return;
  }

  if (options.dryRun) {
    for (const c of tracked) {
      const rel = path.relative(options.workdir, c.srcPath);
      logger.info("migrate", `[dry-run] Skip (git-tracked): ${rel}`, { storyId: "_migrate" });
    }
    for (const c of migratable) {
      logger.info("migrate", `[dry-run] Would move: ${c.srcPath} -> ${path.join(destBase, c.name)}`, {
        storyId: "_migrate",
      });
    }
    return;
  }

  for (const c of tracked) {
    const rel = path.relative(options.workdir, c.srcPath);
    logger.info("migrate", `Skipping git-tracked: ${rel}`, { storyId: "_migrate" });
  }

  await mkdir(destBase, { recursive: true });

  let moved = 0;
  for (const candidate of migratable) {
    const dest = path.join(destBase, candidate.name);
    await mkdir(path.dirname(dest), { recursive: true });

    if (existsSync(dest)) {
      throw new NaxError(
        `Migration conflict: destination already exists.\n  Source:      ${candidate.srcPath}\n  Destination: ${dest}\n  Remove the destination or run nax migrate --dry-run to inspect.`,
        "MIGRATE_CONFLICT",
        { stage: "migrate", src: candidate.srcPath, dest },
      );
    }

    try {
      await rename(candidate.srcPath, dest);
    } catch (err: unknown) {
      const isXdev = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EXDEV";
      if (isXdev) {
        throw new NaxError(
          [
            "Cross-filesystem migration detected.",
            `  Source:      ${candidate.srcPath}`,
            `  Destination: ${dest}`,
            "  Set outputDir in .nax/config.json to a path on the same filesystem as .nax/.",
          ].join("\n"),
          "MIGRATE_CROSS_FS",
          { stage: "migrate", src: candidate.srcPath, dest },
        );
      }
      throw new NaxError(`Failed to move ${candidate.srcPath}`, "MIGRATE_MOVE_FAILED", {
        stage: "migrate",
        src: candidate.srcPath,
        dest,
        cause: err,
      });
    }

    moved++;
    logger.info("migrate", `Moved: ${candidate.name}`, { storyId: "_migrate" });
  }

  if (moved > 0) {
    await Bun.write(
      path.join(destBase, ".migrated-from"),
      JSON.stringify({ from: options.workdir, migratedAt: new Date().toISOString() }, null, 2),
    );

    logger.info("migrate", `Migration complete: ${moved} entries moved`, {
      storyId: "_migrate",
      destBase,
    });
  }
}
