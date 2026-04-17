/**
 * Context Engine v2 — Effectiveness Signal
 *
 * Post-story annotation for kept context chunks (Amendment A AC-45).
 * Classifies each chunk as followed/contradicted/ignored/unknown based on
 * agent output, git diff, and review findings.
 *
 * All classification is deterministic (no LLM). Runs post-story and writes
 * effectiveness signals back into stored context manifests.
 *
 * See: docs/specs/SPEC-context-engine-v2-amendments.md Amendment A.2
 */

import { getLogger } from "../../logger";
import { errorMessage } from "../../utils/errors";
import { _manifestStoreDeps, loadContextManifests } from "./manifest-store";
import type { ChunkEffectiveness } from "./types";

export const _effectivenessDeps = {
  getLogger,
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MIN_SIGNIFICANT_TERMS = 3;

// Stopwords shared with staleness tokenizer — keep in sync.
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "are",
  "was",
  "use",
  "all",
  "can",
  "this",
  "that",
  "with",
  "from",
  "have",
  "been",
  "will",
  "when",
  "their",
  "they",
  "than",
  "its",
  "not",
  "but",
  "each",
  "more",
  "also",
  "into",
  "some",
  "any",
  "our",
  "only",
  "new",
  "may",
  "has",
  "how",
  "his",
  "her",
  "you",
  "your",
]);
const MIN_TOKEN_LEN = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer (local copy — avoids a circular dep between staleness ↔ effectiveness)
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const raw = text
    .toLowerCase()
    .split(/[\s_\-./:,;()\[\]{}'"!?]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
  return new Set(raw);
}

function sharedTermCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const term of a) {
    if (b.has(term)) count++;
  }
  return count;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a single chunk's effectiveness signal.
 *
 * Signal priority (first match wins):
 *   1. contradicted — a review finding shares >= MIN_SIGNIFICANT_TERMS terms
 *      with the chunk summary (finding contradicts the chunk's advice)
 *   2. followed — the git diff shares >= MIN_SIGNIFICANT_TERMS terms with
 *      the chunk summary (agent implemented what the chunk recommended)
 *   3. ignored — the chunk terms appear in neither diff nor agent output
 *   4. unknown — fallback (all inputs empty, or summary too short to compare)
 *
 * @param chunkSummary - first 300 chars of the chunk content
 * @param agentOutput  - agent stdout from AgentResult.output
 * @param diffText     - git diff text from `git diff <ref>..HEAD`
 * @param findingMessages - review finding messages from ReviewFinding.message[]
 */
export function classifyEffectiveness(
  chunkSummary: string,
  agentOutput: string,
  diffText: string,
  findingMessages: string[],
): ChunkEffectiveness {
  const summaryTerms = tokenize(chunkSummary);

  // Too few terms → cannot classify meaningfully
  if (summaryTerms.size < MIN_SIGNIFICANT_TERMS) {
    return { signal: "unknown" };
  }

  // 1. Contradicted: review finding text overlaps with chunk summary
  for (const finding of findingMessages) {
    const findingTerms = tokenize(finding);
    if (sharedTermCount(summaryTerms, findingTerms) >= MIN_SIGNIFICANT_TERMS) {
      return {
        signal: "contradicted",
        evidence: finding.slice(0, 200),
      };
    }
  }

  // 2. Followed: diff overlaps with chunk summary
  if (diffText) {
    const diffTerms = tokenize(diffText);
    if (sharedTermCount(summaryTerms, diffTerms) >= MIN_SIGNIFICANT_TERMS) {
      return {
        signal: "followed",
        evidence: "terms found in diff",
      };
    }
  }

  // 3. Ignored: terms appear in neither diff nor agent output
  if (diffText || agentOutput) {
    const combinedTerms = tokenize(`${diffText} ${agentOutput}`);
    if (sharedTermCount(summaryTerms, combinedTerms) < MIN_SIGNIFICANT_TERMS) {
      return { signal: "ignored" };
    }
  }

  return { signal: "unknown" };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-story manifest annotation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Annotate all stored context manifests for a story with effectiveness signals.
 * Called post-story (after story pipeline completes) — not on the hot path.
 *
 * For each manifest that has chunkSummaries, classifies each included chunk
 * and writes chunkEffectiveness back via read-modify-write.
 *
 * Best-effort: if any single manifest fails to update, the error is swallowed
 * so it does not block story completion.
 */
export async function annotateManifestEffectiveness(
  projectDir: string,
  featureId: string,
  storyId: string,
  {
    agentOutput,
    diffText,
    findingMessages,
  }: {
    agentOutput: string;
    diffText: string;
    findingMessages: string[];
  },
): Promise<void> {
  const stored = await loadContextManifests(projectDir, storyId, featureId);

  for (const item of stored) {
    const { manifest } = item;
    if (!manifest.chunkSummaries || manifest.includedChunks.length === 0) continue;

    const effectiveness: Record<string, ChunkEffectiveness> = {};
    for (const id of manifest.includedChunks) {
      const summary = manifest.chunkSummaries[id];
      if (!summary) continue;
      effectiveness[id] = classifyEffectiveness(summary, agentOutput, diffText, findingMessages);
    }

    if (Object.keys(effectiveness).length === 0) continue;

    // Read-modify-write: reload the raw JSON to preserve unknown fields
    try {
      const raw = await _manifestStoreDeps.readFile(item.path);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed.chunkEffectiveness = effectiveness;
      await _manifestStoreDeps.writeFile(item.path, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch (err) {
      _effectivenessDeps.getLogger().warn("context-v2", "Failed to annotate chunk effectiveness", {
        path: item.path,
        error: errorMessage(err),
      });
    }
  }
}
