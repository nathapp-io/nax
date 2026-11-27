/**
 * Safe resolution of a registered run's backing log file.
 *
 * A registry record either declares its log (`logFileName`, a basename relative to
 * `eventsDir`) or — legacy record — implies `<runId>.jsonl`. A declared name that is
 * invalid or absent never falls back to another file; only a record without the field
 * may try the exact legacy name. Symlinks that escape `eventsDir` and the mutable
 * `latest.jsonl` alias are never followed.
 */

import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { NaxError } from "../errors";

const LOG_BASENAME = /^[A-Za-z0-9._-]+\.jsonl$/;
const LATEST_ALIAS = "latest.jsonl";

/** True when `name` is a single safe `.jsonl` basename (and not the `latest` alias). */
export function isSafeLogBasename(name: unknown): name is string {
  return typeof name === "string" && name !== LATEST_ALIAS && name !== ".jsonl" && LOG_BASENAME.test(name);
}

/**
 * Resolve the log of a registry record to an existing file inside its events directory,
 * or `null` when unavailable.
 */
export function resolveRegisteredLogPath(meta: {
  runId: string;
  eventsDir: string;
  logFileName?: unknown;
}): string | null {
  const name = meta.logFileName === undefined ? `${meta.runId}.jsonl` : meta.logFileName;
  if (!isSafeLogBasename(name)) return null;
  const candidate = join(meta.eventsDir, name);
  if (!existsSync(candidate)) return null;
  try {
    const realDir = realpathSync(meta.eventsDir);
    const realFile = realpathSync(candidate);
    if (!realFile.startsWith(realDir + sep)) return null;
    // Return the resolved target, not the symlink: readers reopen this path, and
    // retargeting the symlink after this check must not redirect them.
    return realFile;
  } catch {
    return null;
  }
}

/**
 * Read a resolved log's text through a handle opened with O_NOFOLLOW, so a symlink swapped in
 * at the resolved path after validation is refused instead of followed. Throws ELOOP/ENOENT.
 * `start` reads from a byte offset.
 */
export function readLogTextNoFollow(path: string, start = 0): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile())
      throw new NaxError(`[registered-log] not a regular file: ${path}`, "LOG_NOT_REGULAR_FILE", { stage: "logs" });
    const buf = readFileSync(fd);
    return buf.subarray(start).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
