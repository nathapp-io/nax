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
import os from "node:os";
import path from "node:path";
import { validateProjectName } from "../cli/init";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { readProjectIdentity, writeProjectIdentity } from "../runtime";

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
    const src = path.join(os.homedir(), ".nax", options.reclaim);
    if (!existsSync(src)) {
      throw new NaxError(`Nothing to reclaim: ~/.nax/${options.reclaim} does not exist`, "MIGRATE_RECLAIM_NOT_FOUND", {
        stage: "migrate",
        name: options.reclaim,
      });
    }
    const archiveBase = path.join(os.homedir(), ".nax", "_archive");
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
      const gitResult = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: options.workdir });
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

  let config: { name?: string } = {};
  try {
    config = await Bun.file(configPath).json();
  } catch (e) {
    throw new NaxError("Failed to read .nax/config.json", "MIGRATE_CONFIG_READ_FAILED", {
      stage: "migrate",
      cause: e,
    });
  }

  const projectKey = config.name?.trim() || path.basename(options.workdir);
  const destBase = path.join(os.homedir(), ".nax", projectKey);
  const candidates = await detectGeneratedContent(naxDir);

  if (candidates.length === 0) {
    logger.info("migrate", "Nothing to migrate — already up to date", { storyId: "_migrate" });
    return;
  }

  if (options.dryRun) {
    for (const c of candidates) {
      logger.info("migrate", `[dry-run] Would move: ${c.srcPath} -> ${path.join(destBase, c.name)}`, {
        storyId: "_migrate",
      });
    }
    return;
  }

  await mkdir(destBase, { recursive: true });

  let moved = 0;
  for (const candidate of candidates) {
    const dest = path.join(destBase, candidate.name);
    await mkdir(path.dirname(dest), { recursive: true });

    if (existsSync(dest)) {
      logger.warn("migrate", `Skipping — destination already exists: ${dest}`, { storyId: "_migrate" });
      continue;
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

  await Bun.write(
    path.join(destBase, ".migrated-from"),
    JSON.stringify({ from: options.workdir, migratedAt: new Date().toISOString() }, null, 2),
  );

  logger.info("migrate", `Migration complete: ${moved} entries moved`, {
    storyId: "_migrate",
    destBase,
  });
}
