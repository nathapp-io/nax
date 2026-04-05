/**
 * Acceptance Test Content Loader
 *
 * Loads acceptance test file content from disk given either:
 *   - An array of test file paths (per-package)
 *   - A single fallback path (legacy single-file)
 *   - No arguments (returns empty array)
 */

export interface AcceptanceEntry {
  testPath: string;
  content: string;
}

/**
 * Load acceptance test file content.
 *
 * @param pathsOrFallback - Array of test paths, a single fallback path, or undefined
 * @returns Array of { testPath, content } pairs
 */
export async function loadAcceptanceTestContent(pathsOrFallback?: string | string[]): Promise<AcceptanceEntry[]> {
  if (!pathsOrFallback) return [];

  if (Array.isArray(pathsOrFallback)) {
    const results: AcceptanceEntry[] = [];
    for (const testPath of pathsOrFallback) {
      const file = Bun.file(testPath);
      if (await file.exists()) {
        results.push({ testPath, content: await file.text() });
      }
    }
    return results;
  }

  // Single path fallback
  const file = Bun.file(pathsOrFallback);
  if (await file.exists()) {
    return [{ testPath: pathsOrFallback, content: await file.text() }];
  }
  return [];
}
