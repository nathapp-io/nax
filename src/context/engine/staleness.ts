/**
 * Context Engine v2 — Staleness Detection
 *
 * Pure helpers for Amendment A AC-46 (age-based staleness) and
 * AC-47 (contradiction-based staleness) in feature context entries.
 *
 * All functions are deterministic (no LLM, no I/O).
 * Called from FeatureContextProviderV2.fetch() at read time.
 *
 * See: docs/specs/SPEC-context-engine-v2-amendments.md Amendment A.3
 */

import type { RawChunk } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

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

const NEGATION_TERMS = ["no longer", "instead", "replaced", "removed", "deprecated"];

const MIN_SHARED_TERMS = 3;
const MIN_TOKEN_LEN = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface FeatureContextEntry {
  section: string;
  index: number;
  text: string;
  establishedIn?: string;
  terms: Set<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract significant tokens from text.
 * Lowercases, splits on whitespace and identifier separators,
 * removes stopwords and short tokens, deduplicates.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const raw = text
    .toLowerCase()
    .split(/[\s_\-./:,;()\[\]{}'"!?]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t));
  return [...new Set(raw)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry parsing
// ─────────────────────────────────────────────────────────────────────────────

const ESTABLISHED_RE = /_Established in:\s*(US-\S+)_/i;
const SECTION_RE = /^##\s+(.+)$/;

/**
 * Parse a feature context.md markdown string into a flat list of entries.
 * Each `## Section` heading starts a new section; paragraphs within a section
 * become individual entries (split on blank lines).
 */
export function parseFeatureContextEntries(markdown: string): FeatureContextEntry[] {
  if (!markdown.trim()) return [];

  const entries: FeatureContextEntry[] = [];
  let currentSection = "";
  let currentParagraph: string[] = [];
  let index = 0;

  function flushParagraph(): void {
    const text = currentParagraph.join("\n").trim();
    if (!text) return;
    const match = ESTABLISHED_RE.exec(text);
    entries.push({
      section: currentSection,
      index: index++,
      text,
      establishedIn: match ? match[1] : undefined,
      terms: new Set(tokenize(text)),
    });
    currentParagraph = [];
  }

  for (const line of markdown.split("\n")) {
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      flushParagraph();
      currentSection = sectionMatch[1].trim();
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
    } else {
      currentParagraph.push(line);
    }
  }
  flushParagraph();

  return entries.filter((e) => e.text.length > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Contradiction detection (AC-47)
// ─────────────────────────────────────────────────────────────────────────────

function containsNegation(text: string): boolean {
  const lower = text.toLowerCase();
  return NEGATION_TERMS.some((term) => lower.includes(term));
}

function sharedTermCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const term of a) {
    if (b.has(term)) count++;
  }
  return count;
}

/**
 * Find entries that are contradicted by a newer entry in the same section.
 * Returns the indices of stale (older) entries.
 *
 * Rule (AC-47): Two entries in the same section share >= 3 significant terms
 * AND the newer entry uses negation language → older entry is stale.
 */
export function detectContradictions(entries: FeatureContextEntry[]): Set<number> {
  const stale = new Set<number>();

  const bySection = new Map<string, FeatureContextEntry[]>();
  for (const e of entries) {
    const group = bySection.get(e.section);
    if (group) {
      group.push(e);
    } else {
      bySection.set(e.section, [e]);
    }
  }

  for (const group of bySection.values()) {
    for (let newer = 1; newer < group.length; newer++) {
      if (!containsNegation(group[newer].text)) continue;
      for (let older = 0; older < newer; older++) {
        if (sharedTermCount(group[older].terms, group[newer].terms) >= MIN_SHARED_TERMS) {
          stale.add(group[older].index);
        }
      }
    }
  }

  return stale;
}

// ─────────────────────────────────────────────────────────────────────────────
// Age-based staleness (AC-46)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find entries older than maxStoryAge positions from the end of the list.
 * Entries without an `_Established in:_` marker are not flagged.
 *
 * Age = entries that came after this entry. Stale when age > maxStoryAge.
 */
export function selectStaleByAge(entries: FeatureContextEntry[], maxStoryAge: number): Set<number> {
  const stale = new Set<number>();
  const total = entries.length;

  for (const e of entries) {
    if (!e.establishedIn) continue;
    const age = total - 1 - e.index;
    if (age > maxStoryAge) {
      stale.add(e.index);
    }
  }

  return stale;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunk annotation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return a new RawChunk with staleCandidate and scoreMultiplier set
 * when the chunk is stale; otherwise returns the chunk unchanged.
 * Does not mutate the input chunk.
 */
export function applyStaleness(
  chunk: RawChunk,
  { isStale, scoreMultiplier }: { isStale: boolean; scoreMultiplier: number },
): RawChunk {
  if (!isStale) return chunk;
  return { ...chunk, staleCandidate: true, scoreMultiplier };
}
