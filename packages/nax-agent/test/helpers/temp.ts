/**
 * Test Temporary Directory Helpers
 *
 * Single source of truth for temp directory creation and cleanup in tests.
 * All temp directories use `os.tmpdir()` for cross-platform portability.
 *
 * Two patterns:
 *   1. `withTempDir(callback)` — async callback, auto-cleanup (best for single-test usage)
 *   2. `makeTempDir()` + `cleanupTempDir()` — lifecycle pair (best for beforeEach/afterEach)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_PREFIX = "nax-test-";

/**
 * Creates a temporary directory (sync). Use in `beforeEach`.
 * Always pair with `cleanupTempDir()` in `afterEach`.
 *
 * @param prefix Optional prefix (default: "nax-test-")
 * @returns Absolute path to the created temp directory
 *
 * @example
 * let tempDir: string;
 * beforeEach(() => { tempDir = makeTempDir("nax-review-"); });
 * afterEach(() => { cleanupTempDir(tempDir); });
 */
export function makeTempDir(prefix = DEFAULT_PREFIX): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Removes a temporary directory (sync). Use in `afterEach`.
 * Safe to call with undefined/null — silently no-ops.
 *
 * @param dir Path returned by `makeTempDir()`
 */
export function cleanupTempDir(dir: string | undefined | null): void {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Creates a temporary directory, runs the callback, then cleans up.
 * Best for tests that need a temp dir only within a single test case.
 *
 * @param callback Function that receives the temp directory path
 * @returns The result of the callback function
 *
 * @example
 * test("writes output file", async () => {
 *   await withTempDir(async (dir) => {
 *     await Bun.write(join(dir, "file.txt"), "content");
 *     expect(existsSync(join(dir, "file.txt"))).toBe(true);
 *   });
 * });
 */
export async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), DEFAULT_PREFIX));

  try {
    return await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
