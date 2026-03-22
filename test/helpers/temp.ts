/**
 * Test Temporary Directory Helper
 *
 * Provides safe temporary directory creation and cleanup for integration tests.
 * All temp directories are created inside test/tmp/ to allow coverage exclusion.
 */

import { mkdtemp, rm } from "fs/promises";
import { mkdirSync } from "fs";
import { join } from "path";

/**
 * Creates a temporary directory and ensures it's cleaned up after the test.
 *
 * The directory is created inside test/tmp/ rather than system /tmp/ to allow
 * coverage exclusion via bunfig.toml.
 *
 * @param callback Function that receives the temp directory path
 * @returns The result of the callback function
 *
 * @example
 * await withTempDir(async (dir) => {
 *   await Bun.write(join(dir, "file.txt"), "content");
 *   // directory is automatically cleaned up after this callback
 * });
 */
export async function withTempDir<T>(
  callback: (dir: string) => Promise<T>,
): Promise<T> {
  // Create test/tmp directory if it doesn't exist
  const testTmpDir = join(process.cwd(), "test", "tmp");
  mkdirSync(testTmpDir, { recursive: true }); // ensure test/tmp exists on clean clones
  const tempDir = await mkdtemp(join(testTmpDir, "nax-"));

  try {
    return await callback(tempDir);
  } finally {
    // Clean up the temporary directory
    await rm(tempDir, { recursive: true, force: true });
  }
}
