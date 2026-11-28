/**
 * Safe resolution of a registered run's backing log file.
 *
 * A registry record either declares its log (`logFileName`, a basename relative to
 * `eventsDir`) or — legacy record — implies `<runId>.jsonl`. A declared name that is
 * invalid or absent never falls back to another file; only a record without the field
 * may try the exact legacy name. Symlinks that escape `eventsDir` and the mutable
 * `latest.jsonl` alias are never followed.
 */

import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
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

/** Bytes per read for incremental log streaming — bounded, so no read materializes the file. */
export const LOG_READ_CHUNK_BYTES = 64 * 1024;

/** Swappable handle operations for `forEachLogChunk` (`_deps` seam). */
export interface LogChunkDeps {
  open: (path: string) => number;
  read: (fd: number, buffer: Uint8Array, offset: number, length: number) => number;
  isRegularFile: (fd: number) => boolean;
  close: (fd: number) => void;
}

/** Real handle operations — the same no-follow, nonblocking open as `readLogTextNoFollow`. */
export const _logChunkDeps: LogChunkDeps = {
  open: (path) => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
  read: (fd, buffer, offset, length) => readSync(fd, buffer, offset, length, null),
  isRegularFile: (fd) => fstatSync(fd).isFile(),
  close: (fd) => closeSync(fd),
};

export interface ForEachLogChunkOptions {
  /** Bytes per read. Defaults to `LOG_READ_CHUNK_BYTES`. */
  chunkBytes?: number;
  /** Handle operations; defaults to `_logChunkDeps`. */
  deps?: LogChunkDeps;
}

/**
 * Visit a log's decoded text in bounded chunks through ONE handle.
 *
 * The handle is opened once — O_NOFOLLOW refuses a symlink swapped in after resolution,
 * O_NONBLOCK cannot block on a FIFO, and a handle that is not a regular file is refused with
 * `LOG_NOT_REGULAR_FILE`. It is never reopened by pathname, so the file that was validated is
 * the file that is read. Multi-byte characters split across reads are decoded intact.
 */
export function forEachLogChunk(
  path: string,
  onChunk: (chunk: string) => void,
  options: ForEachLogChunkOptions = {},
): void {
  const deps = options.deps ?? _logChunkDeps;
  const chunkBytes = options.chunkBytes ?? LOG_READ_CHUNK_BYTES;
  const fd = deps.open(path);
  try {
    if (!deps.isRegularFile(fd))
      throw new NaxError(`[registered-log] not a regular file: ${path}`, "LOG_NOT_REGULAR_FILE", { stage: "logs" });
    const decoder = new TextDecoder("utf-8");
    const buffer = new Uint8Array(chunkBytes);
    for (;;) {
      const read = deps.read(fd, buffer, 0, chunkBytes);
      if (read <= 0) break;
      onChunk(decoder.decode(buffer.subarray(0, read), { stream: true }));
    }
    const tail = decoder.decode();
    if (tail.length > 0) onChunk(tail);
  } finally {
    deps.close(fd);
  }
}
