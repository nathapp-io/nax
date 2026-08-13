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
  tokenize,
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
const TOKEN_PATTERN = /[^\s_\-./:,;()\[\]{}'"!?]+/g;

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer (local copy — avoids a circular dep between staleness ↔ effectiveness)
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  const terms = new Set<string>();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const term = match[0].toLowerCase();
    if (term.length >= MIN_TOKEN_LEN && !STOPWORDS.has(term)) terms.add(term);
  }
  return terms;
}

function sharedTermCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let count = 0;
  for (const term of a) {
    if (b.has(term)) count++;
  }
  return count;
}

interface EffectivenessEvidenceTerms {
  findings: Array<{ message: string; terms: ReadonlySet<string> }>;
  diff?: ReadonlySet<string>;
  combined?: ReadonlySet<string>;
}

export function buildEvidenceTerms(
  agentOutput: string,
  diffText: string,
  findingMessages: string[],
): EffectivenessEvidenceTerms {
  const diffTerms = diffText ? _effectivenessDeps.tokenize(diffText) : undefined;
  const outputTerms = agentOutput ? _effectivenessDeps.tokenize(agentOutput) : undefined;
  let combined: Set<string> | undefined;
  if (diffTerms || outputTerms) {
    combined = new Set(diffTerms);
    for (const term of outputTerms ?? []) combined.add(term);
  }
  return {
    findings: findingMessages.map((message) => ({ message, terms: _effectivenessDeps.tokenize(message) })),
    diff: diffTerms,
    combined,
  };
}

/**
 * Optional scope context for classifyWithTerms (US-003).
 *
 * scopePaths restricts which diff sections contribute evidence. The classifier
 * splits the diff per file once and considers only the added lines of files
 * whose paths match the globs. diffText is the raw unified diff (required when
 * scopePaths is provided; ignored otherwise). When omitted or empty, the
 * classifier falls back to the legacy whole-diff behaviour.
 */
export interface ClassifyScopeOptions {
  scopePaths?: string[];
  diffText?: string;
}

export function classifyWithTerms(
  chunkSummary: string,
  evidence: EffectivenessEvidenceTerms,
  _scopeOptions?: ClassifyScopeOptions,
): ChunkEffectiveness {
  const summaryTerms = _effectivenessDeps.tokenize(chunkSummary);
  if (summaryTerms.size < MIN_SIGNIFICANT_TERMS) return { signal: "unknown" };

  for (const finding of evidence.findings) {
    if (sharedTermCount(summaryTerms, finding.terms) >= MIN_SIGNIFICANT_TERMS) {
      return { signal: "contradicted", evidence: finding.message.slice(0, 200) };
    }
  }

  if (evidence.diff && sharedTermCount(summaryTerms, evidence.diff) >= MIN_SIGNIFICANT_TERMS) {
    return { signal: "followed", evidence: "terms found in diff" };
  }

  if (evidence.combined && sharedTermCount(summaryTerms, evidence.combined) < MIN_SIGNIFICANT_TERMS) {
    return { signal: "ignored" };
  }

  return { signal: "unknown" };
}

// ─────────────────────────────────────────────────────────────────────────────
// splitDiffByFile — US-003: per-file diff sections keyed by post-image path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a unified diff into per-file sections keyed by post-image path.
 *
 * Returns an empty object for inputs that contain no parseable file headers.
 * Binary-marked files map to an empty string (they have no textual hunks to
 * attribute). Renames are keyed by the post-rename path. The implementer
 * replaces the stub body with the real parser — the public shape is fixed so
 * callers (and tests) can rely on it.
 */
export function splitDiffByFile(_diff: string): Record<string, string> {
  // Stub — implementer replaces with the real unified-diff parser.
  return {};
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
  return classifyWithTerms(chunkSummary, buildEvidenceTerms(agentOutput, diffText, findingMessages));
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
  let evidenceTerms: EffectivenessEvidenceTerms | undefined;

  for (const item of stored) {
    const { manifest } = item;
    if (!manifest.chunkSummaries || manifest.includedChunks.length === 0) continue;
    evidenceTerms ??= buildEvidenceTerms(agentOutput, diffText, findingMessages);

    const effectiveness: Record<string, ChunkEffectiveness> = {};
    for (const id of manifest.includedChunks) {
      const summary = manifest.chunkSummaries[id];
      if (!summary) continue;
      effectiveness[id] = classifyWithTerms(summary, evidenceTerms);
    }

    if (Object.keys(effectiveness).length === 0) continue;

    // Read-modify-write: reload the raw JSON to preserve unknown fields
    try {
      const raw = await _manifestStoreDeps.readFile(item.path);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      parsed.chunkEffectiveness = effectiveness;
      await _manifestStoreDeps.writeJson(item.path, parsed);
    } catch (err) {
      _effectivenessDeps.getLogger().warn("context-v2", "Failed to annotate chunk effectiveness", {
        path: item.path,
        error: errorMessage(err),
      });
    }
  }
}
