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
