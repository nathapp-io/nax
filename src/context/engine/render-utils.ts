/**
 * Context Engine v2 — Shared Render Utilities
 *
 * Pure helpers used by both render.ts (default assemble() path) and
 * agent-renderer.ts (rebuildForAgent() / agent-aware path).
 *
 * Extracted to avoid duplicating the scope-grouping and chunk-sorting
 * logic across both renderers — a single source of truth so a separator
 * or ordering change only needs one edit.
 */

import type { PackedChunk } from "./packing";
import type { ChunkScope } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical rendering order for chunk scopes (project-first → retrieved-last). */
export const SCOPE_ORDER: ChunkScope[] = ["project", "feature", "story", "session", "retrieved"];

/** Separator inserted between chunks within the same scope section. */
export const CHUNK_SEPARATOR = "\n\n---\n\n";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Group chunks by scope, preserving SCOPE_ORDER insertion order.
 * Scopes not present in the input are represented as empty arrays.
 */
export function groupByScope(chunks: PackedChunk[]): Map<ChunkScope, PackedChunk[]> {
  const byScope = new Map<ChunkScope, PackedChunk[]>();
  for (const scope of SCOPE_ORDER) byScope.set(scope, []);
  for (const chunk of chunks) {
    const group = byScope.get(chunk.scope);
    if (group) group.push(chunk);
  }
  return byScope;
}

/**
 * Sort a group of same-scope chunks by score descending and join their
 * trimmed content with the standard separator.
 */
export function sortedBodies(group: PackedChunk[]): string {
  return [...group]
    .sort((a, b) => b.score - a.score)
    .map((c) => c.content.trim())
    .join(CHUNK_SEPARATOR);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scratch-entry budget fitting (nax#1757)
// ─────────────────────────────────────────────────────────────────────────────

/** Separator between rendered scratch entries, on both the push and pull paths. */
export const SCRATCH_ENTRY_SEPARATOR = "\n\n";

/**
 * Fit pre-rendered scratch-entry blocks to a character ceiling by dropping
 * whole entries from the OLDEST end, keeping the newest.
 *
 * Both call sites previously joined every block and then took `slice(0, max)`,
 * which keeps the HEAD. On the push path (SessionScratchProvider) the blocks
 * are oldest-first, so that silently evicted the newest entries — the opposite
 * of the recency selection immediately above it — and left a half-rendered
 * entry at the cut. On the pull path (query_scratch) the same slice is correct
 * only when `limit` was supplied and the caller sorted most-recent-first; with
 * no `limit` — the default call — the blocks are oldest-first and it had the
 * same defect.
 *
 * Harmless while every entry was a one-liner; `verify-result` carries a
 * 500-char output tail, so a handful of failing verifies exhausts the ceiling.
 *
 * @param blocks      Rendered entries in display order.
 * @param maxChars    Ceiling for the joined result.
 * @param newestFirst True when `blocks[0]` is the newest (pull path with
 *                    `limit`); false when the newest is last (JSONL order).
 * @returns The joined result, never exceeding `maxChars` — except when a
 *          single newest entry is itself over the ceiling, in which case its
 *          head is returned so the newest entry is still represented rather
 *          than the chunk vanishing entirely.
 */
export function fitScratchBlocks(blocks: readonly string[], maxChars: number, newestFirst = false): string {
  if (blocks.length === 0) return "";
  const kept: string[] = [];
  let used = 0;
  // Walk from the newest end inwards, so what survives is always the newest.
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[newestFirst ? i : blocks.length - 1 - i] ?? "";
    const cost = block.length + (kept.length > 0 ? SCRATCH_ENTRY_SEPARATOR.length : 0);
    if (used + cost > maxChars) break;
    used += cost;
    if (newestFirst) kept.push(block);
    else kept.unshift(block);
  }
  if (kept.length > 0) return kept.join(SCRATCH_ENTRY_SEPARATOR);
  const newest = (newestFirst ? blocks[0] : blocks[blocks.length - 1]) ?? "";
  return newest.slice(0, maxChars);
}
