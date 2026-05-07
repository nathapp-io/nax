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

/**
 * Slugify the leading tokens of an issue string into a stable, human-readable
 * key fragment. Six tokens balances clustering (related findings collide) and
 * specificity (genuinely different issues stay distinct).
 */
function slugLeadingTokens(text: string, tokenCount = 6): string {
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

function buildMeta(f: AnyLLMFinding): Record<string, unknown> | undefined {
  // Only populate meta when LLM-specific annotation fields are present.
  // issue/suggestion are always on LLMFinding and are also included in meta
  // for debuggability, but only when an annotation field anchors the meta.
  const hasAnnotation =
    !!f.acQuote || f.acIndex != null || ("acId" in f && !!f.acId) || ("verifiedBy" in f && !!f.verifiedBy);
  if (!hasAnnotation) return undefined;

  const meta: Record<string, unknown> = {};
  if (f.issue) meta.issue = f.issue;
  if (f.suggestion) meta.suggestion = f.suggestion;
  if (f.acQuote) meta.acQuote = f.acQuote;
  if (f.acIndex != null) meta.acIndex = f.acIndex;
  if ("acId" in f && f.acId) meta.acId = f.acId;
  if ("verifiedBy" in f && f.verifiedBy) meta.verifiedBy = f.verifiedBy;
  return meta;
}

function findingCategory(f: AnyLLMFinding): string | undefined {
  return "category" in f && f.category ? f.category : undefined;
}

export function llmFindingToReviewFinding(f: AnyLLMFinding, opts: ProjectionOptions = {}): ReviewFinding {
  const category = findingCategory(f);
  const result: ReviewFinding = {
    ruleId: deriveRuleId(category, f.issue),
    severity: narrowSeverity(f.severity),
    file: f.file,
    line: f.line,
    message: joinMessage(f.issue, f.suggestion),
  };
  if (category) result.category = category;
  if (opts.source) result.source = opts.source;
  const meta = buildMeta(f);
  if (meta) result.meta = meta;
  return result;
}

export function llmFindingsToReviewFindings(findings: AnyLLMFinding[], opts: ProjectionOptions = {}): ReviewFinding[] {
  return findings.map((f) => llmFindingToReviewFinding(f, opts));
}
