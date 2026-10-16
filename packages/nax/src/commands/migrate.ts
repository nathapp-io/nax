/**
 * nax migrate — project-name collision recovery.
 *
 * Two operator modes, both global-state operations keyed on a project name:
 * `--reclaim <name>` archives `~/.nax/<name>/` so the name is free again, and
 * `--merge <name>` repoints that name's stored identity at the current workdir.
 * With neither flag `migrateCommand` refuses with `MIGRATE_NO_MODE`.
 *
 * Nothing here moves in-repo `.nax/` content: the generated-content migration
 * helpers are gone, because relocating live artifacts took them away from the
 * readers inside the project.
 */

import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { gitSpawnEnv } from "@nathapp/nax-agent/internal";
import { validateProjectName } from "../cli/init";
import { globalConfigDir } from "../config/paths";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { readProjectIdentity, writeProjectIdentity } from "../runtime";

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
