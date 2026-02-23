/**
 * Configuration Path Utilities
 *
 * Provides path resolution for global and project-level config directories.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Returns the global config directory path (~/.nax).
 *
 * @returns Absolute path to global config directory
 */
export function globalConfigDir(): string {
  return join(homedir(), ".nax");
}

/**
 * Returns the project config directory path (projectRoot/nax).
 *
 * @param projectRoot - Absolute or relative path to project root
 * @returns Absolute path to project config directory
 */
export function projectConfigDir(projectRoot: string): string {
  return join(resolve(projectRoot), "nax");
}
