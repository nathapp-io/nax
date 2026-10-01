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

/**
 * Token reserve carved out of the orchestrator's effective budget to hold the
 * digest this stage will produce (which is then threaded forward via
 * ContextRequest.priorStageDigest). Derived from MAX_DIGEST_CHARS at 4 chars/token.
 *
 * Subtracted from the orchestrator's effective budget before provider fetch
 * and before packChunks so the rendered markdown plus digest never exceeds
 * the stage budget.
 */
export const DIGEST_RESERVE_TOKENS = Math.ceil(MAX_DIGEST_CHARS / 4);

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
    if (scopeDiff !== 0) return scopeDiff;
    // CTX-5: code-point comparison, not localeCompare — the digest contract
    // (AC-24) requires byte-identical output across machines, and
    // localeCompare's ordering is not stable across locale/ICU versions.
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // #1774 defect B: static-rules chunks are `### <rulePath>\n\n<section>`, so
  // every section of one rule file produces the identical firstLine summary.
  // Dedupe identical "[scope] summary" lines (keeping the first, sorted
  // occurrence — deterministic) before grouping by scope, so a repeated
  // filename does not multiply-occupy the budget below.
  const seen = new Set<string>();
  const byScope = new Map<ChunkScope, string[]>();
  for (const chunk of sorted) {
    const summary = firstLine(chunk.content);
    if (!summary) continue;
    const line = `[${chunk.scope}] ${summary}`;
    if (seen.has(line)) continue;
    seen.add(line);
    const group = byScope.get(chunk.scope);
    if (group) {
      group.push(line);
    } else {
      byScope.set(chunk.scope, [line]);
    }
  }

  const activeScopes = SCOPE_ORDER.filter((s) => (byScope.get(s)?.length ?? 0) > 0);
  if (activeScopes.length === 0) return "";

  // #1774 defect B: reserve a fair per-scope share of MAX_DIGEST_CHARS so a
  // `project`-scope overflow (the common case — one static-rules chunk per
  // rule section) cannot starve the feature/story/session/retrieved scopes
  // that actually carry stage-to-stage state. Unused share from an earlier
  // scope rolls forward to later ones (SCOPE_ORDER is fixed, so this stays
  // deterministic for a given input).
  const perScopeBudget = Math.floor(MAX_DIGEST_CHARS / activeScopes.length);
  const outLines: string[] = [];
  let rollover = 0;
  for (const scope of activeScopes) {
    const budget = perScopeBudget + rollover;
    let scopeUsed = 0;
    for (const line of byScope.get(scope) ?? []) {
      const cost = outLines.length > 0 ? line.length + 1 : line.length; // +1 for the join newline
      if (scopeUsed + cost > budget) break;
      outLines.push(line);
      scopeUsed += cost;
    }
    rollover = Math.max(0, budget - scopeUsed);
  }

  const raw = outLines.join("\n");
  return raw.length > MAX_DIGEST_CHARS ? `${raw.slice(0, MAX_DIGEST_CHARS - 3)}...` : raw;
}

/** Estimate the token count of a digest string (chars / 4, ceiling) */
export function digestTokens(digest: string): number {
  return Math.ceil(digest.length / 4);
}
