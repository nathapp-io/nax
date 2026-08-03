/**
 * Context Engine v2 — Markdown Renderer
 *
 * Renders packed chunks into the push markdown string.
 * Default style: markdown-sections (## headers), used by assemble().
 * For agent-aware rendering see agent-renderer.ts.
 *
 * Rendering order (spec §AC-9):
 *   Project > Feature > Story > Session > Retrieved
 *
 * Within each scope, chunks are sorted by score descending.
 * Each scope is wrapped in a markdown section header.
 */

import type { PackedChunk } from "./packing";
import { SCOPE_ORDER, groupByScope, sortedBodies } from "./render-utils";
import type { ChunkScope } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Scope headers
// ─────────────────────────────────────────────────────────────────────────────

const SCOPE_HEADERS: Record<ChunkScope, string> = {
  project: "## Project Context",
  feature: "## Feature Context",
  story: "## Story Context",
  session: "## Session History",
  retrieved: "## Retrieved Context",
};

/** Length of CHUNK_SEPARATOR ("\n\n---\n\n") used between chunks in the same scope. */
const CHUNK_SEPARATOR_CHARS = 7;

/** Conservative minimum chunk size used to bound the worst-case separator count. */
const ASSUMED_MIN_CHUNK_TOKENS = 10;

/** Fixed framing overhead for the markdown-sections style (headings + section separators). */
const FIXED_RENDER_OVERHEAD_CHARS = 200;

/** Fixed framing overhead in tokens (chars / 4, ceiling). */
export const FIXED_RENDER_OVERHEAD_TOKENS = Math.ceil(FIXED_RENDER_OVERHEAD_CHARS / 4);

/**
 * Worst-case markdown framing overhead (in characters) for a given packing budget
 * using the markdown-sections style that `assemble()` uses via `renderChunks()`.
 *
 * Components:
 *   - FIXED_RENDER_OVERHEAD_CHARS (200):
 *       1 prior-stage heading ("## Prior Stage Summary\n\n" = 25 chars)
 *       up to 5 scope headings  ("## <Label>\n\n", max 23 chars each = 115 chars)
 *       6 section separators    ("\n\n" = 2 chars each = 12 chars)
 *       48 chars margin
 *   - per-chunk separator overhead:
 *       worst case max chunks = ceil(budgetTokens / ASSUMED_MIN_CHUNK_TOKENS)
 *       each separator adds CHUNK_SEPARATOR_CHARS = 7 chars between chunks
 *       (n-1) separators for n chunks in the worst-case scope
 *
 * Subtracted (as tokens) from the orchestrator's effective budget so the
 * rendered push markdown stays within the stage budget when no floor chunk
 * overflows (AC-7).
 */
export function renderOverheadChars(budgetTokens: number): number {
  const maxChunks = Math.max(1, Math.ceil(budgetTokens / ASSUMED_MIN_CHUNK_TOKENS));
  const separatorChars = (maxChunks - 1) * CHUNK_SEPARATOR_CHARS;
  return FIXED_RENDER_OVERHEAD_CHARS + separatorChars;
}

// ─────────────────────────────────────────────────────────────────────────────
// Actual-chunk overhead (closes the ASSUMED_MIN_CHUNK_TOKENS gap)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the per-chunk separator overhead in tokens from actual chunks.
 *
 * The markdown-sections renderer inserts `CHUNK_SEPARATOR` (\n\n---\n\n, 7 chars)
 * between every pair of chunks in the same scope. The worst-case scope is the
 * one with the most chunks; all others use fewer separators.
 *
 * Called by the orchestrator AFTER min-score filtering (when the actual chunk
 * set is known) so the reserved overhead matches reality — no assumed-minimum
 * heuristic that sub-10-token chunks can defeat.
 */
export function separatorOverheadTokens(chunks: PackedChunk[]): number {
  if (chunks.length === 0) return 0;
  const byScope = groupByScope(chunks);
  let maxInScope = 0;
  for (const group of byScope.values()) maxInScope = Math.max(maxInScope, group.length);
  const separatorChars = (maxInScope - 1) * CHUNK_SEPARATOR_CHARS;
  return Math.ceil(separatorChars / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderOptions {
  /** Digest from the prior pipeline stage, injected as a preamble (optional) */
  priorStageDigest?: string;
}

/**
 * Render packed chunks into a single push markdown string.
 *
 * Empty scopes are omitted. When priorStageDigest is provided, it is
 * prepended before the scope sections.
 */
export function renderChunks(chunks: PackedChunk[], options: RenderOptions = {}): string {
  const sections: string[] = [];

  // Prior stage digest preamble
  if (options.priorStageDigest?.trim()) {
    sections.push(`## Prior Stage Summary\n\n${options.priorStageDigest.trim()}`);
  }

  // Group by scope and render non-empty scopes in order
  const byScope = groupByScope(chunks);
  for (const scope of SCOPE_ORDER) {
    const group = byScope.get(scope) ?? [];
    if (group.length === 0) continue;
    sections.push(`${SCOPE_HEADERS[scope]}\n\n${sortedBodies(group)}`);
  }

  return sections.join("\n\n");
}
