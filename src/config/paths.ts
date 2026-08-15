/**
 * Configuration Path Utilities
 *
 * Provides path resolution for global and project-level config directories.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

const GLOBAL_CONFIG_DIR_ENV = "NAX_GLOBAL_CONFIG_DIR";

/**
 * Returns the global config directory path (~/.nax).
 *
 * @returns Absolute path to global config directory
 */
export function globalConfigDir(): string {
  const override = process.env[GLOBAL_CONFIG_DIR_ENV];
  if (override) return override;
  return join(homedir(), ".nax");
}

/**
 * Hidden project config directory name.
 * Single source of truth — all code uses this constant or projectConfigDir().
 */
export const PROJECT_NAX_DIR = ".nax";

/**
 * Returns the project config directory path (projectRoot/.nax).
 *
 * @param projectRoot - Absolute or relative path to project root
 * @returns Absolute path to project config directory
 */
export function projectConfigDir(projectRoot: string): string {
  return join(resolve(projectRoot), PROJECT_NAX_DIR);
}

/**
 * Feature-tree directory name, relative to a project root (`.nax/features`).
 *
 * For patterns rather than paths — globs, `.gitignore` entries, precheck
 * matchers — where a joined absolute path would be wrong. Always POSIX-separated
 * because every consumer of it is a pattern language, not the filesystem API.
 */
export const PROJECT_FEATURES_DIR = `${PROJECT_NAX_DIR}/features`;

/**
 * Absolute path to the feature tree (`<root>/.nax/features`).
 *
 * Deliberately a plain `join`, not `projectConfigDir()`: that helper calls
 * `resolve()`, which would rebase a relative root against the current working
 * directory. Every caller here already holds an absolute anchor, and silently
 * absolutising a relative one would mask a caller bug rather than surface it.
 *
 * @param root - Repo root for repo-scoped features; a package root for
 *   package-scoped ones (monorepos keep a `.nax/features` tree per package, so
 *   an acceptance test resolves against its own package's imports).
 */
export function featuresDir(root: string): string {
  return join(root, PROJECT_NAX_DIR, "features");
}

/**
 * Absolute path to one feature's directory (`<root>/.nax/features/<featureId>`).
 *
 * This is the single source of truth for where a feature's artifacts live —
 * `prd.json`, `status.json`, `stories/`, `sessions/`, `fragments/`, `context.md`.
 * Build every one of those by joining onto this, never by re-spelling `.nax`.
 * Fragments shipped writing to a stray top-level `features/` dir precisely
 * because the segment was open-coded at each site and one site dropped `.nax`.
 */
export function featureDir(root: string, featureId: string): string {
  return join(featuresDir(root), featureId);
}
