/**
 * Path security utilities for nax (SEC-1, SEC-2).
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

/**
 * Result of a path validation.
 */
export interface PathValidationResult {
  /** Whether the path is valid and allowed */
  valid: boolean;
  /** The absolute, normalized path (if valid) */
  absolutePath?: string;
  /** Error message if invalid */
  error?: string;
}

/**
 * Validates that a module path is within an allowed root directory.
 *
 * @param modulePath - The user-provided path to validate (relative or absolute)
 * @param allowedRoots - Array of absolute paths that are allowed as roots
 * @returns Validation result
 */
/**
 * Resolve symlinks for a path that may not exist yet.
 *
 * Traverses up the directory tree to find the deepest existing ancestor,
 * resolves its real path (following symlinks like /var -> /private/var on macOS),
 * then appends the non-existent suffix. This ensures consistent real-path
 * comparison even when parts of the path don't exist yet.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path doesn't exist — traverse up to find the deepest existing ancestor
    const parts: string[] = [];
    let current = p;

    for (;;) {
      const parent = dirname(current);
      if (parent === current) {
        // Hit filesystem root without finding any existing directory
        return p;
      }
      parts.unshift(basename(current));
      current = parent;
      try {
        const realParent = realpathSync(current);
        return join(realParent, ...parts);
      } catch {
        // Parent also doesn't exist — try grandparent
      }
    }
  }
}

export function validateModulePath(modulePath: string, allowedRoots: string[]): PathValidationResult {
  if (!modulePath) {
    return { valid: false, error: "Module path is empty" };
  }

  // Resolve symlinks in each root for security comparison
  const realRoots = allowedRoots.map((r) => safeRealpath(resolve(r)));

  // If absolute, check real path against real roots
  if (isAbsolute(modulePath)) {
    const normalizedPath = normalize(modulePath);
    const realTarget = safeRealpath(normalizedPath);
    const isWithin = realRoots.some((root) => realTarget.startsWith(`${root}/`) || realTarget === root);
    if (isWithin) {
      // Return normalized (non-symlink-resolved) path so callers get the path they provided
      return { valid: true, absolutePath: normalizedPath };
    }
  } else {
    // If relative, resolve against each original root and check real paths
    for (let i = 0; i < allowedRoots.length; i++) {
      const originalRoot = allowedRoots[i];
      const realRoot = realRoots[i];
      const absolutePath = resolve(join(originalRoot, modulePath));
      const realAbsTarget = safeRealpath(absolutePath);
      if (realAbsTarget.startsWith(`${realRoot}/`) || realAbsTarget === realRoot) {
        return { valid: true, absolutePath };
      }
    }
  }

  return {
    valid: false,
    error: `Path "${modulePath}" is outside allowed roots`,
  };
}
