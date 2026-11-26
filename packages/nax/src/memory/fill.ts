/**
 * How full the rendered memory index is — the measurement the compaction offer,
 * the compaction prompt and the run's nearly-full notice share.
 *
 * The index the agent is handed is bounded by two caps (`renderMemoryIndex`): a
 * byte cap and a line cap. Fill is therefore the larger of the two ratios — an
 * index at 90% of its byte cap and one at 90% of its line cap are equally full,
 * and either can be the one that truncates next.
 *
 * `indexBytes` is the configured `memory.indexBytes`, not the
 * `MEMORY_INDEX_MAX_BYTES` default: a user who lowers the cap has a fuller index
 * at the same text. The line cap has no config key, so the constant is the cap.
 */

import { MEMORY_INDEX_MAX_LINES, type RenderedMemoryIndex } from "@nathapp/nax-agent";
import type { MemoryConfig } from "@/config";

/** UTF-8 byte length: the unit the index's byte cap counts. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Newline-separated line count. Empty text has no lines, not one. */
function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/**
 * Fill as a ratio, 0 for an empty index and above 1 for one past a cap. Both
 * caps are measured over the same text, so a ratio over 1 means the index is
 * being truncated.
 */
export function memoryIndexFill(index: RenderedMemoryIndex, indexBytes: number): number {
  const byteRatio = byteLength(index.text) / indexBytes;
  const lineRatio = lineCount(index.text) / MEMORY_INDEX_MAX_LINES;
  return Math.max(byteRatio, lineRatio);
}

/**
 * Whether memory is at the point a compaction is offered.
 *
 * Entries the caps left out win over the measured fill: an index already
 * dropping notes is full whatever its ratios say, and that is the case the
 * compaction exists to fix. Otherwise the configured threshold decides, inclusive
 * — "at 80% full" is full at exactly 0.8.
 */
export function memoryNearlyFull(index: RenderedMemoryIndex, memory: MemoryConfig): boolean {
  if (index.omitted > 0) return true;
  return memoryIndexFill(index, memory.indexBytes) >= memory.compact.threshold;
}
