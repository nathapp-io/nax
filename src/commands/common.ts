/**
 * Common utilities for CLI commands
 *
 * Provides project resolution logic shared across status, logs, and other commands.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_DIRECTORY_DEPTH } from "../config/path-security";
import { NaxError } from "../errors";

/**
 * Options for project resolution
 */
export interface ResolveProjectOptions {
  /** Explicit project directory (from -d flag) */
  dir?: string;
  /** Feature name (from -f flag) */
  feature?: string;
}

/**
 * Resolved project paths
 */
export interface ResolvedProject {
  /** Absolute path to project root directory */
  projectDir: string;
  /** Absolute path to nax config file */
  configPath: string;
  /** Absolute path to feature directory (if feature specified) */
  featureDir?: string;
}

/**
 * Resolves project directory using the following priority:
 * 1. Explicit -d flag path
 * 2. Current working directory (if it contains .nax/ directory)
 * 3. Walk up directory tree to find .nax/ (up to MAX_DIRECTORY_DEPTH)
 *
 * Validates:
 * - .nax/ directory exists
 * - .nax/config.json exists
 * - .nax/features/<name>/ exists (if feature specified)
 *
 * @param options - Resolution options (dir, feature)
 * @returns Resolved project paths
 * @throws {NaxError} If project cannot be resolved or validation fails
 */
export function resolveProject(options: ResolveProjectOptions = {}): ResolvedProject {
  const { dir, feature } = options;

  // Step 1: Determine project root and validate structure
  let projectRoot: string;
  let naxDir: string;
  let configPath: string;

  if (dir) {
    // Use explicit -d flag path (resolve relative paths and symlinks)
    projectRoot = realpathSync(resolve(dir));
    naxDir = join(projectRoot, ".nax");

    // Validate .nax/ directory exists
    if (!existsSync(naxDir)) {
      throw new NaxError(
        `Directory does not contain a nax project: ${projectRoot}\nExpected to find: ${naxDir}`,
        "NAX_DIR_NOT_FOUND",
        { projectRoot, naxDir },
      );
    }

    // Validate .nax/config.json exists
    configPath = join(naxDir, "config.json");
    if (!existsSync(configPath)) {
      throw new NaxError(
        `.nax directory found but config.json is missing: ${naxDir}\nExpected to find: ${configPath}`,
        "CONFIG_NOT_FOUND",
        { naxDir, configPath },
      );
    }
  } else {
    // Walk up from CWD to find .nax/ directory with config.json
    const found = findProjectRoot(process.cwd());
    if (!found) {
      // Check if CWD has .nax/ but missing config.json (for better error message)
      const cwdNaxDir = join(process.cwd(), ".nax");
      if (existsSync(cwdNaxDir)) {
        const cwdConfigPath = join(cwdNaxDir, "config.json");
        throw new NaxError(
          `.nax directory found but config.json is missing: ${cwdNaxDir}\nExpected to find: ${cwdConfigPath}`,
          "CONFIG_NOT_FOUND",
          { naxDir: cwdNaxDir, configPath: cwdConfigPath },
        );
      }

      throw new NaxError(
        "No nax project found. Run this command from within a nax project directory, or use -d flag to specify the project path.",
        "PROJECT_NOT_FOUND",
        { cwd: process.cwd() },
      );
    }
    projectRoot = found;
    naxDir = join(projectRoot, ".nax");
    configPath = join(naxDir, "config.json");
  }

  // Step 4: Validate feature directory (if specified)
  let featureDir: string | undefined;
  if (feature) {
    const featuresDir = join(naxDir, "features");
    featureDir = join(featuresDir, feature);

    if (!existsSync(featureDir)) {
      // List available features for helpful error message
      const availableFeatures = existsSync(featuresDir)
        ? readdirSync(featuresDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [];

      const availableMsg =
        availableFeatures.length > 0
          ? `\n\nAvailable features:\n${availableFeatures.map((f) => `  - ${f}`).join("\n")}`
          : "\n\nNo features found in this project.";

      throw new NaxError(`Feature not found: ${feature}${availableMsg}`, "FEATURE_NOT_FOUND", {
        feature,
        featuresDir,
        availableFeatures,
      });
    }
  }

  return {
    projectDir: projectRoot,
    configPath,
    featureDir,
  };
}

/**
 * Walks up directory tree to find a .nax/ directory with config.json.
 * Stops at filesystem root or MAX_DIRECTORY_DEPTH.
 *
 * @param startDir - Starting directory (typically CWD)
 * @returns Absolute path to project root (with symlinks resolved), or null if not found
 */
function findProjectRoot(startDir: string): string | null {
  let current = resolve(startDir);
  let depth = 0;

  while (depth < MAX_DIRECTORY_DEPTH) {
    const naxDir = join(current, ".nax");
    const configPath = join(naxDir, "config.json");

    if (existsSync(configPath)) {
      // Resolve symlinks for consistent path comparison
      return realpathSync(current);
    }

    const parent = join(current, "..");
    if (parent === current) {
      // Reached filesystem root
      break;
    }

    current = parent;
    depth++;
  }

  return null;
}
