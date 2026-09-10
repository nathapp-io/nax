/**
 * Path Security Utilities
 *
 * Prevents path traversal attacks by validating and resolving paths.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, normalize, relative, resolve } from "node:path";

/** Maximum directory depth to prevent infinite loops */
export const MAX_DIRECTORY_DEPTH = 10;

export const _pathSecurityDeps = { isAbsolute, normalize, relative };

/**
 * Validate and resolve a directory path safely
 * @param dirPath - The directory path to validate
 * @param baseDir - Optional base directory to check bounds (if provided, dirPath must be within baseDir)
 * @returns Resolved absolute path
 * @throws Error if path is invalid, not a directory, or outside bounds
 */
export function validateDirectory(dirPath: string, baseDir?: string): string {
  // Resolve to absolute path
  const resolved = resolve(dirPath);

  // Check if path exists
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${dirPath}`);
  }

  // Get real path (resolves symlinks)
  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch (error) {
    throw new Error(`Failed to resolve path: ${dirPath} (${(error as Error).message})`);
  }

  // Check if it's a directory
  try {
    const stats = lstatSync(realPath);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${dirPath}`);
    }
  } catch (error) {
    throw new Error(`Failed to stat path: ${dirPath} (${(error as Error).message})`);
  }

  // If baseDir provided, ensure realPath is within baseDir
  if (baseDir) {
    const resolvedBase = resolve(baseDir);
    const realBase = existsSync(resolvedBase) ? realpathSync(resolvedBase) : resolvedBase;

    if (!isWithinDirectory(realPath, realBase)) {
      throw new Error(`Path is outside allowed directory: ${dirPath} (resolved to ${realPath}, base: ${realBase})`);
    }
  }

  return realPath;
}

/**
 * Check if a path is within a base directory (prevents path traversal)
 * @param targetPath - The path to check (must be absolute)
 * @param basePath - The base directory (must be absolute)
 * @returns true if targetPath is within basePath
 */
export function isWithinDirectory(targetPath: string, basePath: string): boolean {
  const normalizedTarget = _pathSecurityDeps.normalize(targetPath);
  const normalizedBase = _pathSecurityDeps.normalize(basePath);

  // Ensure both are absolute
  if (!_pathSecurityDeps.isAbsolute(normalizedTarget) || !_pathSecurityDeps.isAbsolute(normalizedBase)) {
    return false;
  }

  const targetRelativeToBase = _pathSecurityDeps.relative(normalizedBase, normalizedTarget);
  return (
    targetRelativeToBase === "" ||
    (!targetRelativeToBase.startsWith("../") &&
      !targetRelativeToBase.startsWith("..\\") &&
      targetRelativeToBase !== ".." &&
      !_pathSecurityDeps.isAbsolute(targetRelativeToBase))
  );
}

/**
 * Validate file path and ensure it's within a base directory
 * @param filePath - The file path to validate
 * @param baseDir - Base directory (filePath must be within this directory)
 * @returns Resolved absolute path
 * @throws Error if path is invalid or outside bounds
 */
export function validateFilePath(filePath: string, baseDir: string): string {
  const resolved = resolve(filePath);

  // Get real path (resolves symlinks)
  let realPath: string;
  try {
    // For non-existent files, use parent directory's real path.
    // Use basename(resolved) — not filePath.split("/").pop() — so that any ".." components
    // in the original filePath have already been eliminated by resolve() before we take
    // the final path component. This prevents a traversal input like "../../etc/passwd"
    // from being silently reduced to "passwd" when joined to an in-bounds parent.
    if (!existsSync(resolved)) {
      const parent = resolve(resolved, "..");
      if (existsSync(parent)) {
        const realParent = realpathSync(parent);
        realPath = resolve(realParent, basename(resolved));
      } else {
        realPath = resolved;
      }
    } else {
      realPath = realpathSync(resolved);
    }
  } catch (error) {
    throw new Error(`Failed to resolve path: ${filePath} (${(error as Error).message})`);
  }

  // Ensure realPath is within baseDir
  const resolvedBase = resolve(baseDir);
  const realBase = existsSync(resolvedBase) ? realpathSync(resolvedBase) : resolvedBase;

  if (!isWithinDirectory(realPath, realBase)) {
    throw new Error(`Path is outside allowed directory: ${filePath} (resolved to ${realPath}, base: ${realBase})`);
  }

  return realPath;
}
