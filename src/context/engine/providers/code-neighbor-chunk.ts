/**
 * Code-neighbor chunk assembly (US-002)
 *
 * Owns the section→RawChunk pipeline for `CodeNeighborProvider.fetch()`.
 * Pure: no filesystem, no logging, no globals. The provider threads already
 * collected sections into this module along with truncation context, and we
 * return either a `RawChunk` (with `scopePaths` populated) or null when no
 * sections are present.
 *
 * Why this is its own module: `code-neighbor.ts` is grandfathered at the
 * 600-line ratchet. Adding scope-attribution bookkeeping to `fetch()` would
 * push it past the baseline. Extracting chunk assembly lets the provider
 * shrink (or stay flat) while scope attribution is added.
 *
 * Scope contract (US-002 AC1/AC2/AC4):
 *   `RawChunk.scopePaths` lists each analysed file plus the neighbour paths
 *   rendered beneath it, deduped. A shared neighbour across two analysed
 *   files appears exactly once. Order is preserved: each section's touched
 *   file is recorded first, then its neighbours in declaration order, then
 *   the next section continues.
 *
 * Public API:
 *   - `NeighborSection` — the input shape `{ file, neighbors }[]`.
 *   - `assembleCodeNeighborChunk({ sections, truncated, maxGlobFiles })` —
 *     returns a fully populated `RawChunk` or null when `sections` is empty.
 *   - `contentHash8` — exported for the provider when it needs a stable hash
 *     outside this module (kept here so both files share one implementation).
 */

import { createHash } from "node:crypto";
import type { RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — local to chunk assembly (kept here so the provider doesn't grow)
// ─────────────────────────────────────────────────────────────────────────────

/** Token ceiling for the combined neighbour chunk — must match the provider. */
export const MAX_CHUNK_TOKENS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One per-touched-file section in the chunk body.
 *
 * `file` is the touched file path; `neighbors` is the rendered list of
 * forward-deps, reverse-deps, and sibling-test hints (already resolved by
 * `collectNeighbors` upstream). Order within `neighbors` is preserved.
 */
export interface NeighborSection {
  file: string;
  neighbors: string[];
}

/** Inputs for `assembleCodeNeighborChunk`. */
export interface AssembleCodeNeighborChunkInput {
  sections: NeighborSection[];
  /** True when at least one reverse-dep glob was truncated at `maxGlobFiles`. */
  truncated: boolean;
  /** The cap that produced `truncated` — surfaced in the truncation note. */
  maxGlobFiles: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** SHA-256 hex prefix used to derive the chunk id. */
export function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/**
 * Build the deduped `scopePaths` list for a set of sections.
 *
 * Order is preserved by first-occurrence: each section contributes its
 * touched file first, then each neighbour in declaration order. A neighbour
 * already seen in an earlier section is skipped, satisfying AC4 (shared
 * neighbour across two touched files appears exactly once).
 *
 * Pure / stateless — exposed so tests and the provider can share one
 * implementation of the dedup rule.
 */
export function buildScopePaths(sections: readonly NeighborSection[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const section of sections) {
    if (!seen.has(section.file)) {
      seen.add(section.file);
      out.push(section.file);
    }
    for (const neighbor of section.neighbors) {
      if (seen.has(neighbor)) continue;
      seen.add(neighbor);
      out.push(neighbor);
    }
  }
  return out;
}

/**
 * Render the chunk body from a list of sections. Each section produces a
 * `### <file>` header followed by `- <neighbor>` lines. Sections are joined
 * with a blank line. Returns the empty string for an empty `sections` list.
 */
export function renderSections(sections: readonly NeighborSection[]): string {
  const header = "## Code Neighbors\n\nRelated files (imports, reverse-deps, tests):";
  const body = sections.map((s) => `### ${s.file}\n${s.neighbors.map((n) => `- ${n}`).join("\n")}`).join("\n\n");
  return `${header}\n\n${body}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// assembleCodeNeighborChunk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the code-neighbour chunk from already-collected sections.
 *
 * Returns `null` when no sections are included (preserves the empty-chunk
 * behaviour from `CodeNeighborProvider.fetch` — US-002 AC3).
 *
 * The returned chunk carries:
 *   - `scopePaths` populated per the contract above (AC1/AC2/AC4)
 *   - `id = "code-neighbor:<hash8>"` for stable identity across reruns
 *   - `kind: "neighbor"`, `scope: "story"`, `role: ["implementer", "tdd"]`
 *   - `rawScore: 0.65` (unchanged from the pre-extraction implementation)
 *   - `tokens = ceil(content.length / 4)`
 *   - the visible truncation note when `truncated === true`
 *
 * The chunk's content is capped at `MAX_CHUNK_TOKENS * 4` characters
 * (unchanged from the prior implementation). When the cap kicks in, the
 * truncation note (if any) is appended AFTER the cap is applied so the note
 * itself is never sliced off.
 */
export function assembleCodeNeighborChunk(input: AssembleCodeNeighborChunkInput): RawChunk | null {
  const { sections, truncated, maxGlobFiles } = input;
  if (sections.length === 0) return null;

  const scopePaths = buildScopePaths(sections);
  const rawContent = renderSections(sections);

  // Cap body first so the truncation note (when present) is never sliced off.
  const maxChars = MAX_CHUNK_TOKENS * 4;
  const body = rawContent.length > maxChars ? rawContent.slice(0, maxChars) : rawContent;
  const truncationNote = truncated
    ? `\n\n> Note: reverse-dep scan capped at ${maxGlobFiles} files; some neighbors may be missing.\n> Increase \`context.v2.providers.maxGlobFiles\` or set \`sourceGlob\` to a narrower pattern (e.g. \`**/*.go\`) to reduce the scan footprint.`
    : "";
  const content = body + truncationNote;
  const tokens = Math.ceil(content.length / 4);

  return {
    id: `code-neighbor:${contentHash8(content)}`,
    kind: "neighbor",
    scope: "story",
    role: ["implementer", "tdd"],
    content,
    tokens,
    rawScore: 0.65,
    scopePaths,
  };
}
