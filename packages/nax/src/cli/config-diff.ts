/**
 * Config Diffing
 *
 * Compare global and project configurations.
 */

/**
 * Represents a single config field difference.
 */
export interface ConfigDiff {
  /** Dot-separated field path (e.g., "execution.maxIterations") */
  path: string;
  /** Value from global config */
  globalValue: unknown;
  /** Value from project config */
  projectValue: unknown;
}

/**
 * Deep diff two config objects, returning only fields that differ.
 *
 * @param global - Global config (defaults + global overrides)
 * @param project - Project config (raw overrides only)
 * @param currentPath - Current path in object tree (for recursion)
 * @returns Array of differences
 */
export function deepDiffConfigs(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
  currentPath: string[] = [],
): ConfigDiff[] {
  const diffs: ConfigDiff[] = [];

  // Iterate over project config keys (we only care about what project overrides)
  for (const key of Object.keys(project)) {
    const projectValue = project[key];
    const globalValue = global[key];
    const path = [...currentPath, key];
    const pathStr = path.join(".");

    // Handle nested objects
    if (
      projectValue !== null &&
      typeof projectValue === "object" &&
      !Array.isArray(projectValue) &&
      globalValue !== null &&
      typeof globalValue === "object" &&
      !Array.isArray(globalValue)
    ) {
      // Recurse into nested object
      const nestedDiffs = deepDiffConfigs(
        globalValue as Record<string, unknown>,
        projectValue as Record<string, unknown>,
        path,
      );
      diffs.push(...nestedDiffs);
    } else {
      // Compare primitive values or arrays
      if (!deepEqual(projectValue, globalValue)) {
        diffs.push({
          path: pathStr,
          globalValue,
          projectValue,
        });
      }
    }
  }

  return diffs;
}

/**
 * Deep equality check for two values.
 *
 * @param a - First value
 * @param b - Second value
 * @returns True if values are deeply equal
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a === undefined || b === undefined) return false;

  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, idx) => deepEqual(val, b[idx]));
  }

  // Handle objects
  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    if (aKeys.length !== bKeys.length) return false;

    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }

  return false;
}
