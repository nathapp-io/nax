/**
 * Source-side projection of LLM reviewer findings → canonical ReviewFinding.
 *
 * Issue #942 — semantic / adversarial / semantic-debate reviewers historically
 * persisted their LLMFinding shape (issue/suggestion, no ruleId/message) to
 * `.nax/review-audit/*.json`, which forced the curator collector to fall back
 * to `category` for ruleId and collapsed H1 buckets to coarse single words
 * ("assumption" / "input" / "unknown" 39×).
 *
 * This module is the SSOT for the projection. Every audit-write call site
 * must convert LLMFinding[] → ReviewFinding[] through these helpers BEFORE
 * persisting to disk so downstream consumers (curator, future review
 * dashboards) only deal with the canonical shape.
 */

import type { ReviewFinding } from "../plugins/extensions";
import type { AdversarialLLMFinding } from "./adversarial-helpers";
import type { LLMFinding } from "./semantic-helpers";

type AnyLLMFinding = LLMFinding | AdversarialLLMFinding;

export interface ProjectionOptions {
  /** Producer label for `ReviewFinding.source` (e.g. "semantic-review"). */
  source?: string;
}

const SEVERITY_MAP: Record<string, ReviewFinding["severity"]> = {
  critical: "critical",
  error: "error",
  warning: "warning",
  warn: "warning",
  info: "info",
  low: "low",
};

function narrowSeverity(raw: string): ReviewFinding["severity"] {
  return SEVERITY_MAP[raw] ?? "info";
}

/** Six tokens balances clustering (related findings collide) and specificity (genuinely different issues stay distinct). */
const RULE_ID_SLUG_TOKENS = 6;

/**
 * Slugify the leading tokens of an issue string into a stable, human-readable
 * key fragment.
 */
function slugLeadingTokens(text: string, tokenCount = RULE_ID_SLUG_TOKENS): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, tokenCount)
    .join("-");
}

function deriveRuleId(category: string | undefined, issue: string): string {
  const prefix = category?.trim() ? category.trim() : "review";
  const slug = slugLeadingTokens(issue) || "unspecified";
  return `${prefix}:${slug}`;
}

function joinMessage(issue: string, suggestion: string | undefined): string {
  const trimmedIssue = issue.trim();
  const trimmedSuggestion = (suggestion ?? "").trim();
  if (trimmedIssue && trimmedSuggestion) {
    return `${trimmedIssue}\n→ ${trimmedSuggestion}`;
  }
  return trimmedIssue;
}

function buildMeta(f: AnyLLMFinding, originalSeverity?: string): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  // Always persist raw issue/suggestion so autofix consumers can address them separately.
  if (f.issue) meta.issue = f.issue;
  if (f.suggestion) meta.suggestion = f.suggestion;
  // AC-annotation fields — only when present and valid.
  if (f.acQuote) meta.acQuote = f.acQuote;
  // acIndex is 1-based; 0 is a buggy LLM emission and must not be persisted.
  if (typeof f.acIndex === "number" && f.acIndex >= 1) meta.acIndex = f.acIndex;
  if ("acId" in f && f.acId) meta.acId = f.acId;
  if ("verifiedBy" in f && f.verifiedBy) meta.verifiedBy = f.verifiedBy;
  // Preserve the raw severity when narrowing changes the value so consumers
  // can still bucket "unverifiable" separately from genuine info findings.
  if (originalSeverity !== undefined) meta.originalSeverity = originalSeverity;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function findingCategory(f: AnyLLMFinding): string | undefined {
  return "category" in f && f.category ? f.category : undefined;
}

export function llmFindingToReviewFinding(f: AnyLLMFinding, opts: ProjectionOptions = {}): ReviewFinding {
  const category = findingCategory(f);
  const narrowed = narrowSeverity(f.severity);
  const result: ReviewFinding = {
    ruleId: deriveRuleId(category, f.issue),
    severity: narrowed,
    file: f.file,
    line: f.line,
    message: joinMessage(f.issue, f.suggestion),
  };
  if (category) result.category = category;
  if (opts.source) result.source = opts.source;
  const meta = buildMeta(f, f.severity !== narrowed ? f.severity : undefined);
  if (meta) result.meta = meta;
  return result;
}

export function llmFindingsToReviewFindings(findings: AnyLLMFinding[], opts: ProjectionOptions = {}): ReviewFinding[] {
  return findings.map((f) => llmFindingToReviewFinding(f, opts));
}
