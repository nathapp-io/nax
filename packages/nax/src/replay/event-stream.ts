/**
 * Incremental JSONL ingestion for `nax replay`.
 *
 * Records are decoded in bounded chunks from ONE no-follow, nonblocking,
 * regular-file-checked handle (see `forEachLogChunk`) and folded straight into
 * the per-story index, so neither the whole file text, the split line array nor
 * the parsed record array is ever materialized. One pass per record, whatever
 * the story count.
 */

import { existsSync } from "node:fs";
import type { LogEntry } from "../logger/types";
import { forEachLogChunk, type LogChunkDeps } from "../utils/registered-log";
import { createReplayEventIndex, indexEvent } from "./phase-infer";
import type { ReplayEventIndex } from "./types";

/** Options for `ingestReplayLog` / `readReplayEvents`. */
export interface IngestReplayLogOptions {
  /** Bytes per read. Defaults to `LOG_READ_CHUNK_BYTES`. */
  chunkBytes?: number;
  /** Handle operations; defaults to the real no-follow handle. */
  deps?: LogChunkDeps;
}

/**
 * Parse one JSONL line. Blank and malformed lines are skipped — the lenient
 * reading `nax replay` has always applied to a damaged log spine.
 */
function addRecord(index: ReplayEventIndex, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    indexEvent(index, JSON.parse(trimmed) as LogEntry);
  } catch {
    // A malformed record is skipped, exactly as the pre-streaming loader did.
  }
}

/**
 * Feed a decoded chunk to `addRecord`, carrying an incomplete trailing line into
 * the next chunk. The carry is only concatenated when a chunk actually ends a
 * line, so a single record spanning many reads is not re-copied per read.
 */
function feedChunk(index: ReplayEventIndex, carry: string, chunk: string): string {
  const parts = chunk.split("\n");
  if (parts.length === 1) return carry + chunk;
  addRecord(index, carry + (parts[0] ?? ""));
  for (let i = 1; i < parts.length - 1; i++) addRecord(index, parts[i] ?? "");
  return parts[parts.length - 1] ?? "";
}

/**
 * Stream a JSONL log into a per-story index.
 *
 * Reads incrementally through one handle, so a symlink or a nonregular file is
 * refused (ELOOP / `LOG_NOT_REGULAR_FILE`) rather than streamed. A final line
 * without a trailing newline is still ingested, and a record split across reads
 * is reassembled before parsing.
 */
export function ingestReplayLog(path: string, options: IngestReplayLogOptions = {}): ReplayEventIndex {
  const index = createReplayEventIndex();
  let carry = "";
  forEachLogChunk(
    path,
    (chunk) => {
      carry = feedChunk(index, carry, chunk);
    },
    options,
  );
  addRecord(index, carry);
  return index;
}

/**
 * Read a replay log into an index, keeping the existing lenient input handling:
 * a missing log yields an empty index, while a path that cannot safely be
 * streamed (symlink, nonregular file) is reported to the caller rather than
 * silently treated as empty.
 */
export async function readReplayEvents(path: string, options: IngestReplayLogOptions = {}): Promise<ReplayEventIndex> {
  if (!existsSync(path)) return createReplayEventIndex();
  return ingestReplayLog(path, options);
}
