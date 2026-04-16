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
