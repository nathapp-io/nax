/**
 * Safe resolution of a registered run's backing log file.
 *
 * A registry record either declares its log (`logFileName`, a basename relative to
 * `eventsDir`) or — legacy record — implies `<runId>.jsonl`. A declared name that is
 * invalid or absent never falls back to another file; only a record without the field
 * may try the exact legacy name. Symlinks that escape `eventsDir` and the mutable
 * `latest.jsonl` alias are never followed.
 */

import { existsSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

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
