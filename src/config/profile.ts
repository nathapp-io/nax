/**
 * profile.ts — Profile resolution functions for layered config profiles.
 *
 * Story US-001-C
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDotenv } from "./dotenv";
import { deepMergeConfig } from "./merger";
import { globalConfigDir, projectConfigDir } from "./paths";

interface ProfileEntry {
  name: string;
  path: string;
}

/**
 * Loads a named profile by deep-merging global and project-scoped JSON files.
 * Project values take precedence over global values.
 * Throws when neither global nor project profile exists.
 */
export async function loadProfile(profileName: string, projectRoot: string): Promise<Record<string, unknown>> {
  const globalPath = join(globalConfigDir(), "profiles", `${profileName}.json`);
  const projectPath = join(projectConfigDir(projectRoot), "profiles", `${profileName}.json`);

  const globalFile = Bun.file(globalPath);
  const projectFile = Bun.file(projectPath);

  const [globalExists, projectExists] = await Promise.all([globalFile.exists(), projectFile.exists()]);

  if (!globalExists && !projectExists) {
    throw new Error(`Profile "${profileName}" not found in global or project config`);
  }

  let base: Record<string, unknown> = {};

  if (globalExists) {
    base = await globalFile.json();
  }

  if (projectExists) {
    const projectData = await projectFile.json();
    base = deepMergeConfig(base, projectData);
  }

  return base;
}

/**
 * Loads and merges .env files for a named profile.
 * Project values override global, and both override process.env entries.
 * Returns an empty record when no .env files exist.
 */
export async function loadProfileEnv(profileName: string, projectRoot: string): Promise<Record<string, string>> {
  const globalPath = join(globalConfigDir(), "profiles", `${profileName}.env`);
  const projectPath = join(projectConfigDir(projectRoot), "profiles", `${profileName}.env`);

  const globalFile = Bun.file(globalPath);
  const projectFile = Bun.file(projectPath);

  const [globalExists, projectExists] = await Promise.all([globalFile.exists(), projectFile.exists()]);

  if (!globalExists && !projectExists) {
    return {};
  }

  let merged: Record<string, string> = {};

  if (globalExists) {
    const globalContent = await globalFile.text();
    merged = { ...merged, ...parseDotenv(globalContent) };
  }

  if (projectExists) {
    const projectContent = await projectFile.text();
    merged = { ...merged, ...parseDotenv(projectContent) };
  }

  return merged;
}

/**
 * Resolves the active profile name using priority:
 * CLI option > NAX_PROFILE env var > project config.json profile field > "default"
 */
export async function resolveProfileName(
  cliOptions: { profile?: string },
  env: Record<string, string | undefined>,
  projectRoot: string,
): Promise<string> {
  if (cliOptions.profile) {
    return cliOptions.profile;
  }

  if (env.NAX_PROFILE) {
    return env.NAX_PROFILE;
  }

  const configPath = join(projectConfigDir(projectRoot), "config.json");
  const configFile = Bun.file(configPath);

  if (await configFile.exists()) {
    const config = await configFile.json();
    if (typeof config.profile === "string" && config.profile) {
      return config.profile;
    }
  }

  return "default";
}

/**
 * Scans both global and project .nax/profiles/ directories and returns
 * profile names with their paths.
 */
export async function listProfiles(projectRoot: string): Promise<ProfileEntry[]> {
  const globalProfilesDir = join(globalConfigDir(), "profiles");
  const projectProfilesDir = join(projectConfigDir(projectRoot), "profiles");

  const entries: ProfileEntry[] = [];

  for (const dir of [globalProfilesDir, projectProfilesDir]) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (file.endsWith(".json")) {
        const name = file.replace(/\.json$/, "");
        entries.push({ name, path: join(dir, file) });
      }
    }
  }

  return entries;
}
