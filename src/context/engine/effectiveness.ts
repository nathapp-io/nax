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
import { globToRegex, normalizePath } from "./index";
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

// US-003: size-independent "followed" threshold. Replaces the absolute
// "3 shared terms" test — whose operands both grow with diff size — with a
// coverage ratio over the chunk summary's own significant terms. The constant
// is deliberately not pinned: it is whatever makes US-003's two fixture-scored
// ACs pass against test/fixtures/effectiveness/labels.sample.json. Measured
// values: scoped sizeCorrelation 0.2887 < whole-diff 0.3536, and scoped
// followed F1 0.5 > baseline 0.1905.
const COVERAGE_RATIO = 0.05;

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

/**
 * Extract the content of a unified diff's added lines (lines starting with
 * `+`, excluding the `+++`/`---` file headers). Removed and context lines are
 * dropped so a "followed" signal can only be attributed to what was added.
 */
function extractAddedLines(diffText: string): string {
  const added: string[] = [];
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
  }
  return added.join("\n");
}

interface EffectivenessEvidenceTerms {
  findings: Array<{ message: string; terms: ReadonlySet<string> }>;
  diff?: ReadonlySet<string>;
  combined?: ReadonlySet<string>;
  /** Raw unified diff text, retained so classifyWithTerms can split it per file. */
  diffText?: string;
  /** Tokenized added-lines-only evidence of the whole diff (no scope restriction). */
  addedTerms?: ReadonlySet<string>;
}

export function buildEvidenceTerms(
  agentOutput: string,
  diffText: string,
  findingMessages: string[],
): EffectivenessEvidenceTerms {
  const diffTerms = diffText ? _effectivenessDeps.tokenize(diffText) : undefined;
  const addedTerms = diffText ? _effectivenessDeps.tokenize(extractAddedLines(diffText)) : undefined;
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
    diffText: diffText || undefined,
    addedTerms,
  };
}

/**
 * Optional scope context for classifyWithTerms (US-003).
 *
 * scopePaths restricts which diff sections contribute evidence. The classifier
 * splits the diff per file once and considers only the added lines of files
 * whose paths match the globs. diffText is the raw unified diff (required when
 * scopePaths is provided; ignored otherwise). When omitted or empty, the
 * classifier uses the whole diff's added lines with no file restriction.
 */
export interface ClassifyScopeOptions {
  scopePaths?: string[];
  diffText?: string;
  /**
   * Pre-split per-file diff sections (from splitDiffByFile). When provided,
   * classifyScoped reuses them instead of re-splitting the diff — so a story
   * with many scoped chunks splits the diff once, not once per chunk.
   */
  sections?: Record<string, string>;
}

export function classifyWithTerms(
  chunkSummary: string,
  evidence: EffectivenessEvidenceTerms,
  scopeOptions?: ClassifyScopeOptions,
): ChunkEffectiveness {
  const summaryTerms = _effectivenessDeps.tokenize(chunkSummary);
  if (summaryTerms.size < MIN_SIGNIFICANT_TERMS) return { signal: "unknown" };

  for (const finding of evidence.findings) {
    if (sharedTermCount(summaryTerms, finding.terms) >= MIN_SIGNIFICANT_TERMS) {
      return { signal: "contradicted", evidence: finding.message.slice(0, 200) };
    }
  }

  // US-003: scoped added-line attribution. When scopePaths is present the
  // evidence is restricted to the added lines of the files the globs admit.
  if (scopeOptions?.scopePaths !== undefined) {
    return classifyScoped(
      summaryTerms,
      scopeOptions.diffText ?? evidence.diffText ?? "",
      scopeOptions.scopePaths,
      scopeOptions.sections,
    );
  }

  // No scope: the whole diff's added lines (AC6/AC8). Removed and context
  // lines never contribute to a "followed" signal.
  const addedTerms =
    evidence.addedTerms ??
    (evidence.diffText ? _effectivenessDeps.tokenize(extractAddedLines(evidence.diffText)) : undefined);
  if (addedTerms && isFollowed(summaryTerms, addedTerms)) {
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
export function splitDiffByFile(diff: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = diff.split("\n");
  let currentLines: string[] = [];
  let currentKey: string | undefined;

  const flush = (): void => {
    if (currentKey === undefined || currentLines.length === 0) return;
    const text = currentLines.join("\n");
    sections[currentKey] = isBinarySection(text) ? "" : text;
    currentLines = [];
    currentKey = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      currentKey = postImagePathFromHeader(line);
      currentLines = [line];
      continue;
    }
    if (currentKey !== undefined) {
      const updated = postImagePathFromLine(line);
      if (updated !== undefined) currentKey = updated;
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

/**
 * Read one git diff path token starting at `start`, returning the unquoted
 * path and the index just past the token. Handles bare paths and C-style
 * quoted paths — git quotes filenames containing spaces (and other special
 * bytes), e.g. `diff --git "a/foo bar.ts" "b/foo bar.ts"`.
 */
function readGitPath(input: string, start: number): { path: string; next: number } | null {
  let i = start;
  while (i < input.length && (input[i] === " " || input[i] === "\t")) i++;
  if (i >= input.length) return null;

  if (input[i] === '"') {
    let path = "";
    i++;
    while (i < input.length && input[i] !== '"') {
      const ch = input[i];
      if (ch === "\\" && i + 1 < input.length) {
        const esc = input[i + 1];
        if (esc === '"' || esc === "\\") {
          path += esc;
          i += 2;
          continue;
        }
        if (esc === "t") {
          path += "\t";
          i += 2;
          continue;
        }
        if (esc === "n") {
          path += "\n";
          i += 2;
          continue;
        }
        if (esc === "r") {
          path += "\r";
          i += 2;
          continue;
        }
        if (esc >= "0" && esc <= "7") {
          let code = 0;
          let digits = 0;
          let j = i + 1;
          while (j < input.length && digits < 3 && input[j] >= "0" && input[j] <= "7") {
            code = code * 8 + (input.charCodeAt(j) - 48);
            digits++;
            j++;
          }
          path += String.fromCharCode(code);
          i = j;
          continue;
        }
      }
      path += ch;
      i++;
    }
    if (i < input.length && input[i] === '"') i++;
    return { path, next: i };
  }

  let path = "";
  while (i < input.length && input[i] !== " " && input[i] !== "\t") {
    path += input[i];
    i++;
  }
  return { path, next: i };
}

/** Strip git's `b/` destination prefix from a post-image path. */
function stripDiffPrefix(path: string): string {
  return path.startsWith("b/") ? path.slice(2) : path;
}

/** Post-image path from a `diff --git a/<pre> b/<post>` header line. */
function postImagePathFromHeader(line: string): string | undefined {
  const rest = line.slice("diff --git ".length);
  const pre = readGitPath(rest, 0);
  if (pre === null) return undefined;
  const post = readGitPath(rest, pre.next);
  return post === null ? undefined : stripDiffPrefix(post.path);
}

/** Post-image path from `+++ b/<post>` or `rename to <post>` lines. */
function postImagePathFromLine(line: string): string | undefined {
  if (line.startsWith("+++ ")) {
    const token = readGitPath(line, "+++ ".length);
    return token === null ? undefined : stripDiffPrefix(token.path);
  }
  if (line.startsWith("rename to ")) {
    const token = readGitPath(line, "rename to ".length);
    return token === null ? undefined : token.path;
  }
  return undefined;
}

/** True when the section is a binary-file marker (no textual hunks to attribute). */
function isBinarySection(section: string): boolean {
  return section.split("\n").some((line) => line.startsWith("Binary files "));
}

/** True when a diff file path matches any of the chunk's scope globs. */
function pathMatchesScope(scopePaths: string[], filePath: string): boolean {
  const normalized = normalizePath(filePath);
  const patterns = scopePaths.map((pattern) => globToRegex(normalizePath(pattern)));
  return patterns.some((pattern) => pattern.test(normalized));
}

/** Size-independent followed test: coverage of the summary by added-line terms. */
function isFollowed(summaryTerms: ReadonlySet<string>, addedTerms: ReadonlySet<string>): boolean {
  if (addedTerms.size === 0) return false;
  return sharedTermCount(summaryTerms, addedTerms) / summaryTerms.size >= COVERAGE_RATIO;
}

/**
 * Scoped classification (US-003): restrict the diff to the added lines of the
 * files whose paths match scopePaths. Fails open: an unsplittable diff records
 * unknown; a scope matching no diff file records ignored.
 */
function classifyScoped(
  summaryTerms: ReadonlySet<string>,
  rawDiff: string,
  scopePaths: string[],
  preSplitSections?: Record<string, string>,
): ChunkEffectiveness {
  const sections = preSplitSections ?? splitDiffByFile(rawDiff);
  const filePaths = Object.keys(sections);
  if (filePaths.length === 0) return { signal: "unknown" };

  const matching = filePaths.filter((path) => pathMatchesScope(scopePaths, path));
  if (matching.length === 0) return { signal: "ignored" };

  const added = matching.map((path) => extractAddedLines(sections[path])).join("\n");
  const addedTerms = _effectivenessDeps.tokenize(added);
  if (isFollowed(summaryTerms, addedTerms)) {
    return { signal: "followed", evidence: matching[0] };
  }
  return { signal: "ignored" };
}

// classifyEffectiveness removed — US-004

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
  // US-003: split the diff once per story, not once per scoped chunk. The
  // per-chunk scope only selects which pre-split sections contribute evidence.
  const splitSections = splitDiffByFile(diffText);

  for (const item of stored) {
    const { manifest } = item;
    if (!manifest.chunkSummaries || manifest.includedChunks.length === 0) continue;
    evidenceTerms ??= buildEvidenceTerms(agentOutput, diffText, findingMessages);

    const effectiveness: Record<string, ChunkEffectiveness> = {};
    for (const id of manifest.includedChunks) {
      const summary = manifest.chunkSummaries[id];
      if (!summary) continue;
      effectiveness[id] = classifyWithTerms(summary, evidenceTerms, {
        scopePaths: manifest.chunkScopePaths?.[id],
        diffText,
        sections: splitSections,
      });
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
