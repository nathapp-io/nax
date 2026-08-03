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

/** Fixed framing overhead for the markdown-sections style (headings + section separators). */
const FIXED_RENDER_OVERHEAD_CHARS = 200;

/** Fixed framing overhead in tokens (chars / 4, ceiling). */
export const FIXED_RENDER_OVERHEAD_TOKENS = Math.ceil(FIXED_RENDER_OVERHEAD_CHARS / 4);

// ─────────────────────────────────────────────────────────────────────────────
// Actual-chunk overhead
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the per-chunk separator overhead in tokens from actual chunks.
 *
 * The markdown-sections renderer inserts `CHUNK_SEPARATOR` (\n\n---\n\n, 7 chars)
 * between every pair of chunks in the same scope, in EVERY non-empty scope
 * section — not just the largest one. The total is the sum of (count - 1)
 * separators across all non-empty scope groups.
 *
 * Called by the orchestrator AFTER min-score filtering, over `kept` — every chunk
 * that survived the filter, not only the (smaller) set that ends up packed. This
 * is a conservative UPPER BOUND on the real separator cost, not an exact measure:
 * chunks packing excludes still reduce the reserve, shrinking the effective budget
 * by more than the separators actually rendered will cost. That is deliberately
 * safe (never under-reserves), but it is not "no assumed-minimum heuristic" — it
 * assumes every kept chunk packs. A tighter reserve would need to run after
 * packing, which chicken-and-eggs against the ceiling packing itself consumes.
 */
export function separatorOverheadTokens(chunks: PackedChunk[]): number {
  if (chunks.length === 0) return 0;
  const byScope = groupByScope(chunks);
  let totalSeparators = 0;
  for (const group of byScope.values()) {
    if (group.length > 1) totalSeparators += group.length - 1;
  }
  const separatorChars = totalSeparators * CHUNK_SEPARATOR_CHARS;
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
