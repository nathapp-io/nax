/**
 * Path security utilities for nax (SEC-1, SEC-2).
 */

import { isAbsolute, join, normalize, resolve } from "node:path";

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
export function validateModulePath(modulePath: string, allowedRoots: string[]): PathValidationResult {
  if (!modulePath) {
    return { valid: false, error: "Module path is empty" };
  }

  const normalizedRoots = allowedRoots.map((r) => resolve(r));

  // If absolute, just check against roots
  if (isAbsolute(modulePath)) {
    const absoluteTarget = normalize(modulePath);
    const isWithin = normalizedRoots.some((root) => {
      return absoluteTarget.startsWith(`${root}/`) || absoluteTarget === root;
    });
    if (isWithin) {
      return { valid: true, absolutePath: absoluteTarget };
    }
  } else {
    // If relative, check if it's within any root when resolved relative to that root
    for (const root of normalizedRoots) {
      const absoluteTarget = resolve(join(root, modulePath));
      if (absoluteTarget.startsWith(`${root}/`) || absoluteTarget === root) {
        return { valid: true, absolutePath: absoluteTarget };
      }
    }
  }

  return {
    valid: false,
    error: `Path "${modulePath}" is outside allowed roots`,
  };
}
