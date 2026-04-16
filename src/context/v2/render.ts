/**
 * Context Engine v2 — Markdown Renderer
 *
 * Renders packed chunks into the push markdown string.
 *
 * Rendering order (spec §AC-9):
 *   Project > Feature > Story > Session > Retrieved
 *
 * Within each scope, chunks are sorted by score descending.
 * Each scope is wrapped in a markdown section header.
 */

import type { PackedChunk } from "./packing";
import type { ChunkScope } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Scope ordering
// ─────────────────────────────────────────────────────────────────────────────

const SCOPE_ORDER: ChunkScope[] = ["project", "feature", "story", "session", "retrieved"];

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

  // Group by scope
  const byScope = new Map<ChunkScope, PackedChunk[]>();
  for (const scope of SCOPE_ORDER) {
    byScope.set(scope, []);
  }

  for (const chunk of chunks) {
    const group = byScope.get(chunk.scope);
    if (group) {
      group.push(chunk);
    }
  }

  // Render non-empty scopes in order
  for (const scope of SCOPE_ORDER) {
    const group = byScope.get(scope) ?? [];
    if (group.length === 0) continue;

    // Sort by score descending within scope
    const sorted = [...group].sort((a, b) => b.score - a.score);

    const header = SCOPE_HEADERS[scope];
    const bodies = sorted.map((c) => c.content.trim()).join("\n\n---\n\n");
    sections.push(`${header}\n\n${bodies}`);
  }

  return sections.join("\n\n");
}
