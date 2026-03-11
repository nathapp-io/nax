/**
 * Shared JSON File I/O Utility
 *
 * Provides type-safe, error-tolerant helpers for reading and writing JSON files.
 * Encapsulates common patterns: existsSync check, try/catch, logging.
 */

import { existsSync } from "node:fs";
import { getLogger } from "../logger";

/**
 * Load a JSON file with type safety and error handling.
 *
 * Returns null if the file doesn't exist or cannot be parsed.
 * Logs a warning if parsing fails.
 *
 * @param path - File path to load
 * @param context - Logger context (e.g., "config", "hooks", "metrics")
 * @returns Parsed JSON object, or null if file missing or invalid
 *
 * @example
 * ```ts
 * const config = await loadJsonFile<NaxConfig>("nax/config.json", "config");
 * ```
 */
export async function loadJsonFile<T>(path: string, context = "json-file"): Promise<T | null> {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const content = await Bun.file(path).json();
    return content as T;
  } catch (err) {
    const logger = getLogger();
    logger.warn(context, "Failed to parse JSON file", {
      path,
      error: String(err),
    });
    return null;
  }
}

/**
 * Save an object as JSON to a file.
 *
 * Writes formatted JSON (2-space indent) for readability.
 * Creates parent directories if they don't exist.
 *
 * @param path - File path to write to
 * @param data - Object to serialize
 * @param context - Logger context (for errors)
 * @throws Error if write fails
 *
 * @example
 * ```ts
 * await saveJsonFile("nax/config.json", config, "config");
 * ```
 */
export async function saveJsonFile<T>(path: string, data: T, context = "json-file"): Promise<void> {
  try {
    const json = JSON.stringify(data, null, 2);
    await Bun.write(path, json);
  } catch (err) {
    const logger = getLogger();
    logger.error(context, "Failed to write JSON file", {
      path,
      error: String(err),
    });
    throw err;
  }
}
