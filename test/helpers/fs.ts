/**
 * fs.ts — File system helpers for bun:test.
 *
 * Provides utilities for polling file system events and async file operations.
 */

import { access } from "node:fs/promises";
import { constants } from "node:fs";

/**
 * Polls for a file to exist up to timeoutMs.
 * Used instead of Bun.sleep() for timing-sensitive file operations in tests.
 *
 * @param path - File path to wait for
 * @param timeoutMs - Maximum wait time in milliseconds (default: 500)
 * @param pollIntervalMs - Poll interval in milliseconds (default: 10)
 * @throws Error if file doesn't exist within timeout
 */
export async function waitForFile(
  path: string,
  timeoutMs = 500,
  pollIntervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await access(path, constants.F_OK);
      return; // File exists
    } catch {
      // File doesn't exist yet, continue polling
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`waitForFile: ${path} not created within ${timeoutMs}ms`);
}
