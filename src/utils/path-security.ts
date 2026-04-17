/**
 * Path security utilities for nax (SEC-1, SEC-2).
 */

import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

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
 * Recursively resolve symlinks by walking up to the deepest existing ancestor.
 * Returns the real path for comparison purposes only — callers must use the
 * un-resolved path as the user-visible absolutePath return value.
 */
function safeRealpathForComparison(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (parent === p) return normalize(p); // filesystem root
    const resolvedParent = safeRealpathForComparison(parent);
    return join(resolvedParent, p.split("/").pop() ?? "");
  }
}

/**
 * Returns true when filePath is safe to use as a relative file path — i.e. it
 * contains no `..` segments and is not an absolute path.  Used by context-engine
 * providers to gate user-supplied paths before any filesystem or git call.
 */
export function isRelativeAndSafe(filePath: string): boolean {
  if (!filePath) return false;
  if (isAbsolute(filePath)) return false;
  if (filePath.includes("..")) return false;
  return true;
}

export function validateModulePath(modulePath: string, allowedRoots: string[]): PathValidationResult {
  if (!modulePath) {
    return { valid: false, error: "Module path is empty" };
  }

  // Resolve symlinks in each root for security comparison
  const resolvedRoots = allowedRoots.map((r) => safeRealpathForComparison(resolve(r)));

  // If absolute, compare resolved paths but return the un-resolved normalized path
  if (isAbsolute(modulePath)) {
    const normalized = normalize(modulePath);
    const resolved = safeRealpathForComparison(normalized);
    const isWithin = resolvedRoots.some((root) => resolved.startsWith(`${root}/`) || resolved === root);
    if (isWithin) {
      return { valid: true, absolutePath: normalized };
    }
  } else {
    // If relative, resolve relative to each original (non-symlinked) root
    for (let i = 0; i < allowedRoots.length; i++) {
      const originalRoot = resolve(allowedRoots[i]);
      const absoluteInput = resolve(join(originalRoot, modulePath));
      const resolved = safeRealpathForComparison(absoluteInput);
      const resolvedRoot = resolvedRoots[i];
      if (resolved.startsWith(`${resolvedRoot}/`) || resolved === resolvedRoot) {
        return { valid: true, absolutePath: absoluteInput };
      }
    }
  }

  return {
    valid: false,
    error: `Path "${modulePath}" is outside allowed roots`,
  };
}
