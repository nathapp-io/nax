/**
 * Context Engine v2 — CodeNeighborProvider shared content cache (GROWTH-2)
 *
 * Split from code-neighbor.ts per project-conventions.md file-size ratchet.
 * Bounds per-fetch() memory when reading candidate files into the shared
 * content cache: a per-file size cap (skip unread files over
 * MAX_NEIGHBOR_FILE_SIZE_BYTES) and an aggregate cache budget
 * (MAX_NEIGHBOR_CACHE_TOTAL_BYTES) that stops retaining further content once
 * exceeded, without capping any single call's read-and-return.
 */

import { errorMessage } from "@/utils/errors";

/** Max size (bytes) of a candidate file read into the shared content cache; larger files are skipped unread (GROWTH-2). */
export const MAX_NEIGHBOR_FILE_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * Max aggregate bytes retained in the shared content cache across one fetch()
 * call (GROWTH-2 follow-up). The per-file cap alone only bounds a SINGLE
 * file's contribution — with maxGlobFiles defaulting to 500 per scanned dir
 * (and multiple workspace-package dirs scanned per fetch, see code-neighbor.ts's
 * maxGlobFiles doc), many just-under-the-cap files can still accumulate into
 * hundreds of MB. Once this budget is exceeded, further reads are still
 * performed (and returned) for the current call but are no longer retained
 * in the Map — a "stop retaining new entries" guard, not a full LRU.
 */
export const MAX_NEIGHBOR_CACHE_TOTAL_BYTES = 50 * 1024 * 1024;

/**
 * Shared per-fetch() cache state: the content cache itself, a running total
 * of retained bytes (GROWTH-2 aggregate cap), and a separate set of paths
 * skipped as oversized (kept apart from `cache` so an oversized file's
 * "skipped" state is never conflated with a genuinely empty/unreadable file
 * cached as `""` — see readCached's oversized-file branch).
 */
export interface ContentCacheState {
  cache: Map<string, string>;
  totalBytes: number;
  oversizedSkipped: Set<string>;
}

export function createContentCacheState(): ContentCacheState {
  return { cache: new Map(), totalBytes: 0, oversizedSkipped: new Set() };
}

/** Minimal logger shape readCached needs — matches Logger.warn's signature. */
interface WarnLogger {
  warn(stage: string, message: string, data?: Record<string, unknown>): void;
}

/** Deps required by readCached — a structural subset of _codeNeighborDeps (code-neighbor.ts). */
export interface ReadCachedDeps {
  fileSize: (path: string) => Promise<number>;
  readFile: (path: string) => Promise<string>;
  getLogger: () => WarnLogger;
}

/** True for the benign "file vanished between glob and stat" race — anything else is unexpected. */
function isBenignStatRace(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && (err as { code?: unknown }).code === "ENOENT";
}

/**
 * Read a file's content via the shared cache (avoids redundant disk reads
 * across touched files).
 *
 * GROWTH-2: skips the read for files over the per-file size cap, and once
 * the aggregate cache budget (MAX_NEIGHBOR_CACHE_TOTAL_BYTES) is exceeded,
 * stops retaining further content in the Map (still reads-and-returns it for
 * the current call's use).
 *
 * The per-file size check is best-effort: a benign stat race (file deleted
 * between glob and stat, ENOENT) falls through to the real read silently.
 * Any other stat failure — including `deps.fileSize` being missing/
 * misconfigured entirely — is logged as a warning so the size cap being
 * silently bypassed is observable instead of silent.
 */
export async function readCached(
  absolutePath: string,
  state: ContentCacheState,
  deps: ReadCachedDeps,
): Promise<string | null> {
  const cached = state.cache.get(absolutePath);
  if (cached !== undefined) return cached;
  if (state.oversizedSkipped.has(absolutePath)) return null;

  if (typeof deps.fileSize !== "function") {
    deps
      .getLogger()
      .warn("context-v2", "_codeNeighborDeps.fileSize is not a function — size cap disabled for this read", {
        absolutePath,
      });
  } else {
    try {
      const size = await deps.fileSize(absolutePath);
      if (Number.isFinite(size) && size > MAX_NEIGHBOR_FILE_SIZE_BYTES) {
        state.oversizedSkipped.add(absolutePath);
        return null;
      }
    } catch (err) {
      if (!isBenignStatRace(err)) {
        deps
          .getLogger()
          .warn("context-v2", "Unexpected error from _codeNeighborDeps.fileSize — size cap bypassed for this read", {
            absolutePath,
            error: errorMessage(err),
          });
      }
      /* fall through to the real read */
    }
  }

  try {
    const content = await deps.readFile(absolutePath);
    const contentBytes = Buffer.byteLength(content, "utf8");
    if (state.totalBytes + contentBytes <= MAX_NEIGHBOR_CACHE_TOTAL_BYTES) {
      state.cache.set(absolutePath, content);
      state.totalBytes += contentBytes;
    }
    return content;
  } catch {
    // Mark as unreadable so we don't retry
    state.cache.set(absolutePath, "");
    return null;
  }
}
