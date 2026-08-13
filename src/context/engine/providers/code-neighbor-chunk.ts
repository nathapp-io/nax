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
 * Truncation contract (US-002 AC2): `scopePaths` must list ONLY the paths
 * whose full form appears in `chunk.content`.
 *   1. Whole sections that would overflow the cap are dropped atomically
 *      (never sliced mid-section) — their paths are absent from the body.
 *   2. The first section is always included so the chunk emits at least
 *      the header + something; if its rendered length exceeds the cap the
 *      body is sliced mid-section. Neighbour paths sliced by that cut
 *      are excluded from `scopePaths` (their full form is not in the
 *      body), while the section's file path is kept (it lives in the
 *      section header which fits inside the slice).
 * Mirrors the git-history truncation pattern (US-001).
 */
export function assembleCodeNeighborChunk(input: AssembleCodeNeighborChunkInput): RawChunk | null {
  const { sections, truncated, maxGlobFiles } = input;
  if (sections.length === 0) return null;

  const header = "## Code Neighbors\n\nRelated files (imports, reverse-deps, tests):";
  const SECTION_SEPARATOR = "\n\n";
  const maxChars = MAX_CHUNK_TOKENS * 4;

  // Build the body incrementally, dropping sections that would push the
  // total past the cap. `includedSections` records which sections were
  // admitted into the body so the second pass can resolve scopePaths.
  const accumulatedParts: string[] = [`${header}${SECTION_SEPARATOR}`];
  let accumulatedLength = header.length + SECTION_SEPARATOR.length;
  const includedSections: NeighborSection[] = [];
  for (const section of sections) {
    const rendered = `### ${section.file}\n${section.neighbors.map((n) => `- ${n}`).join("\n")}`;
    const separatorCost = includedSections.length === 0 ? 0 : SECTION_SEPARATOR.length;
    const candidateLength = accumulatedLength + separatorCost + rendered.length;
    // First section is always included; subsequent sections must fit
    // atomically — drop entirely when adding would overflow.
    if (includedSections.length > 0 && candidateLength > maxChars) break;
    if (separatorCost > 0) accumulatedParts.push(SECTION_SEPARATOR);
    accumulatedParts.push(rendered);
    accumulatedLength = candidateLength;
    includedSections.push(section);
  }
  const body = accumulatedParts.join("").slice(0, maxChars);
  const truncationNote = truncated
    ? `\n\n> Note: reverse-dep scan capped at ${maxGlobFiles} files; some neighbors may be missing.\n> Increase \`context.v2.providers.maxGlobFiles\` or set \`sourceGlob\` to a narrower pattern (e.g. \`**/*.go\`) to reduce the scan footprint.`
    : "";
  const content = body + truncationNote;
  const tokens = Math.ceil(content.length / 4);

  // Resolve scopePaths to only those paths whose full form is rendered in
  // the (possibly sliced) body. A path that was sliced mid-name is absent
  // — its full form is not in chunk.content, so it doesn't qualify as
  // "rendered in the chunk body" (AC2). Dedup by first-occurrence per the
  // existing AC4 contract.
  const scopePaths: string[] = [];
  const seen = new Set<string>();
  for (const section of includedSections) {
    if (!seen.has(section.file) && body.includes(section.file)) {
      seen.add(section.file);
      scopePaths.push(section.file);
    }
    for (const neighbor of section.neighbors) {
      if (seen.has(neighbor)) continue;
      if (body.includes(neighbor)) {
        seen.add(neighbor);
        scopePaths.push(neighbor);
      }
    }
  }

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
