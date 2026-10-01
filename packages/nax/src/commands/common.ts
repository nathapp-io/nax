/**
 * Common utilities for CLI commands
 *
 * Provides project resolution logic shared across status, logs, and other commands.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { MAX_DIRECTORY_DEPTH } from "../config/path-security";
import { globalConfigDir } from "../config/paths";
import { NaxError } from "../errors";
import { validateFeatureName } from "../utils/feature-name";

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
    try {
      validateFeatureName(feature);
    } catch (error) {
      throw new NaxError((error as Error).message, "FEATURE_INVALID", { feature });
    }
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
 * Derives the single feature name from `.nax/features/*` when the caller didn't pass
 * `-f`/`--feature` explicitly. `config.json` never carries a `feature` field (there is
 * no such key in `NaxConfigSchema`) — commands that read `config.feature` always get
 * `undefined` and fail unconditionally without an explicit flag.
 *
 * `remediationHint` must describe how *this specific command* actually disambiguates —
 * not every caller has a `-f`/`--feature` flag (e.g. `nax logs` binds `-f` to
 * `--follow` and has no feature flag at all; it disambiguates via `-r <runId>` instead).
 *
 * @throws {NaxError} when there are zero or more than one feature directories —
 *   the caller must resolve the ambiguity via `remediationHint` in either case.
 */
export function resolveSingleFeature(naxDir: string, remediationHint = "pass -f <name>"): string {
  const featuresDir = join(naxDir, "features");
  const available = existsSync(featuresDir)
    ? readdirSync(featuresDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : [];

  if (available.length === 1) return available[0];

  if (available.length === 0) {
    throw new NaxError(`No feature specified and no features found — ${remediationHint}.`, "FEATURE_NOT_SPECIFIED", {
      featuresDir,
    });
  }

  throw new NaxError(
    `No feature specified and multiple features exist — ${remediationHint}.\n\nAvailable features:\n${available.map((f) => `  - ${f}`).join("\n")}`,
    "FEATURE_AMBIGUOUS",
    { featuresDir, available },
  );
}

/**
 * Resolves a project by name from the global identity registry (~/.nax/<name>/.identity).
 * Falls back to path-based resolution when the value looks like a filesystem path.
 *
 * Resolution order:
 * 1. Try path-based resolution (existing behaviour — handles absolute, relative, and CWD walk-up)
 * 2. If the path doesn't exist on disk, try name-based lookup via the identity registry
 *
 * @param options - Resolution options (dir may be a name or a path, feature optional)
 * @returns Resolved project paths
 * @throws {NaxError} If project cannot be resolved by either strategy
 */
export async function resolveProjectAsync(options: ResolveProjectOptions = {}): Promise<ResolvedProject> {
  const { dir } = options;

  if (!dir) {
    return resolveProject(options);
  }

  // Path wins when it exists on disk — no ambiguity.
  if (existsSync(resolve(dir))) {
    return resolveProject(options);
  }

  // Only attempt name lookup when `dir` is a plain name (no path separators).
  // If it contains separators it was meant as a path; let resolveProject throw the normal error.
  const isPlainName = !dir.includes("/") && !dir.includes("\\");
  if (isPlainName) {
    const registryIdentityPath = join(globalConfigDir(), dir, ".identity");
    const identityFile = Bun.file(registryIdentityPath);
    if (await identityFile.exists()) {
      try {
        const identity = (await identityFile.json()) as Record<string, unknown>;
        if (typeof identity.workdir === "string") {
          return resolveProject({ ...options, dir: identity.workdir });
        }
      } catch {
        // Corrupt identity file — fall through to the informative error below
      }
    }
    throw new NaxError(
      `No project found for name or path: "${dir}"\nChecked filesystem path: ${resolve(dir)}\nChecked identity registry: ${registryIdentityPath}\nTip: use an absolute or relative path, or run "nax init" in your project directory first.`,
      "PROJECT_NOT_FOUND",
      { dir, resolvedPath: resolve(dir), registryIdentityPath },
    );
  }

  try {
    return resolveProject(options);
  } catch (err) {
    // realpathSync throws a raw ENOENT when the path doesn't exist — wrap it as a NaxError
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new NaxError(`Path does not exist: ${resolve(dir)}`, "PROJECT_NOT_FOUND", {
        dir,
        resolvedPath: resolve(dir),
        cause: err,
      });
    }
    throw err;
  }
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
