/**
 * Context Engine v2 — Digest Builder
 *
 * Builds a deterministic ≤250 token summary of the packed chunks.
 * This digest is threaded stage-to-stage via ContextRequest.priorStageDigest
 * so downstream stages know what earlier stages injected.
 *
 * Determinism rule: given the same set of chunk IDs and contents, the digest
 * must be byte-identical across runs. Chunk ordering in the digest is
 * by scope (project > feature > story > session > retrieved) then by chunk ID
 * within each scope.
 *
 * Token budget: the orchestrator reserves digestTokens from the effective
 * budget before packing. In Phase 0 we target ≤250 tokens ≈ ≤1000 chars.
 */

import type { PackedChunk } from "./packing";
import type { ChunkScope } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Hard character limit for the digest (≈250 tokens × 4 chars/token) */
const MAX_DIGEST_CHARS = 1_000;

const SCOPE_ORDER: ChunkScope[] = ["project", "feature", "story", "session", "retrieved"];

// ─────────────────────────────────────────────────────────────────────────────
// Digest builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a first-sentence summary of a chunk's content.
 * Takes the first non-empty line up to 120 chars.
 */
function firstLine(content: string): string {
  const line =
    content
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l.length > 0) ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * Build the digest string from packed chunks.
 *
 * Format (deterministic, scope-ordered):
 *   [project] <first-line of chunk 1>
 *   [feature] <first-line of chunk 2>
 *   ...
 *
 * Truncated to MAX_DIGEST_CHARS if necessary.
 */
export function buildDigest(chunks: PackedChunk[]): string {
  if (chunks.length === 0) return "";

  // Sort deterministically: scope order, then chunk ID within scope
  const scopeRank = Object.fromEntries(SCOPE_ORDER.map((s, i) => [s, i]));
  const sorted = [...chunks].sort((a, b) => {
    const scopeDiff = (scopeRank[a.scope] ?? 99) - (scopeRank[b.scope] ?? 99);
    return scopeDiff !== 0 ? scopeDiff : a.id.localeCompare(b.id);
  });

  const lines: string[] = [];
  for (const chunk of sorted) {
    const summary = firstLine(chunk.content);
    if (summary) {
      lines.push(`[${chunk.scope}] ${summary}`);
    }
  }

  const raw = lines.join("\n");
  return raw.length > MAX_DIGEST_CHARS ? `${raw.slice(0, MAX_DIGEST_CHARS - 3)}...` : raw;
}

/** Estimate the token count of a digest string (chars / 4, ceiling) */
export function digestTokens(digest: string): number {
  return Math.ceil(digest.length / 4);
}
