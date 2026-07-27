/**
 * Adversarial Review Helper Types and Utilities
 *
 * Private interfaces and parsing/formatting helpers extracted from adversarial.ts
 * to keep each file within the 600-line project limit.
 */

import type { Finding, FindingSeverity } from "../findings";
import { tryParseLLMJson } from "../utils/llm-json";
import { categoryToFixTarget, resolveFixTarget } from "./category-fix-target";
import { isBlockingSeverity } from "./severity";
export { isBlockingSeverity };

export interface AdversarialLLMFinding {
  severity: string;
  category: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
  /**
   * Verbatim substring of the AC bullet that constrains this finding's locus.
   * Required for severity "error" / "critical" (Issue #930 Part 1).
   * Validated by filterByAcQuote() before findings reach the story blocker pipeline.
   */
  acQuote?: string;
  /** 1-based index into story.acceptanceCriteria corresponding to acQuote. */
  acIndex?: number;
  /**
   * Scope-grounding counterpart to `acQuote`, for findings about work that
   * crossed a feature-level exclusion: a verbatim substring of the
   * `story.outOfScope` entry indexed by `scopeIndex`.
   *
   * An exclusion is not an AC, so such a finding has no `acQuote` to offer and
   * would otherwise be ungrounded. Validated by filterByScopeQuote() so a
   * fabricated boundary is dropped instead of reaching the story report and the
   * next tier's escalation context.
   */
  scopeQuote?: string;
  /** 1-based index into story.outOfScope corresponding to scopeQuote. */
  scopeIndex?: number;
  /**
   * Required for severity "error" / "critical" (Issue #987): evidence anchoring
   * the finding to real source. `observed` is a verbatim 1–3 line code excerpt
   * from `verifiedBy.file` (defaulting to `file`). Substring-checked against
   * HEAD by checkFindingEvidence + downgradeUnsubstantiatedFinding before
   * findings reach filterByAcQuote.
   */
  verifiedBy?: {
    command?: string;
    file: string;
    line?: number;
    observed: string;
  };
}

export interface AdversarialLLMResponse {
  passed: boolean;
  findings: AdversarialLLMFinding[];
}

/**
 * Validate parsed JSON matches the expected adversarial LLM response shape.
 */
export function validateAdversarialShape(parsed: unknown): AdversarialLLMResponse | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (!Array.isArray(obj.findings)) return null;
  return { passed: obj.passed, findings: obj.findings as AdversarialLLMFinding[] };
}

/**
 * Parse and validate adversarial LLM JSON response.
 * Returns null only when all extraction tiers fail or shape validation fails.
 */
export function parseAdversarialResponse(raw: string): AdversarialLLMResponse | null {
  try {
    return validateAdversarialShape(tryParseLLMJson(raw));
  } catch {
    return null;
  }
}

/** Format findings into readable text output. */
export function formatFindings(findings: AdversarialLLMFinding[]): string {
  return findings
    .map((f) => `[${f.severity}][${f.category}] ${f.file}:${f.line} — ${f.issue}\n  Suggestion: ${f.suggestion}`)
    .join("\n");
}

/** Normalize LLM severity values to FindingSeverity. */
export function normalizeSeverity(sev: string): FindingSeverity {
  if (sev === "warn") return "warning";
  if (
    sev === "critical" ||
    sev === "error" ||
    sev === "warning" ||
    sev === "info" ||
    sev === "low" ||
    sev === "unverifiable"
  )
    return sev;
  return "info";
}

/** Convert AdversarialLLMFinding[] to Finding[] with adversarial-review source. */
export function toAdversarialReviewFindings(
  findings: AdversarialLLMFinding[],
  opts: { isTestFile?: (path: string) => boolean } = {},
): Finding[] {
  return findings.map((f) => {
    const metaExtras: Record<string, unknown> = {};
    if (f.acQuote) metaExtras.acQuote = f.acQuote;
    if (f.acIndex != null) metaExtras.acIndex = f.acIndex;
    if (f.verifiedBy) metaExtras.verifiedBy = f.verifiedBy;
    // Scope grounding travels with the finding: the story report and the next
    // tier's escalation context are exactly where a reader needs to tell a
    // grounded scope finding from an unverifiable one.
    if (f.scopeQuote) metaExtras.scopeQuote = f.scopeQuote;
    if (f.scopeIndex != null) metaExtras.scopeIndex = f.scopeIndex;
    return {
      source: "adversarial-review",
      severity: normalizeSeverity(f.severity),
      category: f.category,
      file: f.file,
      line: f.line,
      message: f.issue,
      suggestion: f.suggestion,
      fixTarget: resolveFixTarget({ base: categoryToFixTarget(f.category), file: f.file, isTestFile: opts.isTestFile }),
      meta: Object.keys(metaExtras).length > 0 ? metaExtras : undefined,
    };
  });
}
