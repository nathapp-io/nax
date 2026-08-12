/**
 * Shared JSON File I/O Utility
 *
 * Provides type-safe, error-tolerant helpers for reading and writing JSON files.
 * Encapsulates common patterns: existsSync check, try/catch, logging.
 */

import { existsSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
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
 * Save an object as JSON to a file, atomically.
 *
 * Writes formatted JSON (2-space indent) for readability. Creates parent
 * directories if they don't exist. The write goes to a sibling temp file
 * first, then `rename()`s it over the destination — a concurrent reader
 * (e.g. another process's {@link loadJsonFile} call) always observes either
 * the fully-written old content or the fully-written new content, never a
 * torn/partial write (BUG-08).
 *
 * This does not by itself make read-modify-write sequences atomic across
 * processes — two writers that both read the same prior content and append
 * to it can still race, with the later `rename()` winning and the earlier
 * writer's append lost. It only eliminates the *torn read* failure mode,
 * where a reader mid-write parses truncated JSON and callers coerce that
 * `null` into "no prior history".
 *
 * Two narrower caveats: the rename is not crash-durable (no `fsync` before
 * it — a power loss between `Bun.write` and `rename` can still leave a
 * zero-length destination on some filesystems), and a hard kill between the
 * two steps leaves an orphaned `<path>.tmp-<uuid>` sibling (the `catch`
 * cleanup only runs on a thrown error, not a killed process).
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
  const tmpPath = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    const json = JSON.stringify(data, null, 2);
    await Bun.write(tmpPath, json);
    await rename(tmpPath, path);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const logger = getLogger();
    logger.error(context, "Failed to write JSON file", {
      path,
      error: String(err),
    });
    throw err;
  }
}
