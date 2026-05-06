/**
 * AC Quote Validator (Issue #930 Part 1)
 *
 * Validates that reviewer "error" findings are grounded in the story's acceptance
 * criteria. Ungrounded findings are dropped before they can block a story or bias
 * next-tier escalation context.
 *
 * Rules (per issue spec):
 * 1. acQuote must be a whitespace-normalised substring of acceptanceCriteria[acIndex-1].
 * 2. acQuote must contain at least one keyword from the flagged locus (file basename or
 *    first meaningful token of the issue message).
 * 3. Only findings with severity "error" or "critical" are subject to validation.
 *    Warnings, info, and unverifiable pass through unchanged.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimum shape required for AC-quote validation — satisfied by both LLMFinding and AdversarialLLMFinding. */
export interface AcQuotable {
  severity: string;
  file?: string;
  issue: string;
  acQuote?: string;
  acIndex?: number;
}

export type AcQuoteRejectionCode =
  | "missing_ac_quote"
  | "ac_index_out_of_range"
  | "ac_quote_not_substring"
  | "ac_quote_does_not_constrain_locus";

export interface AcQuoteValidationResult {
  valid: boolean;
  code?: AcQuoteRejectionCode;
}

/** Finding types that require acQuote validation. */
const BLOCKING_SEVERITIES = new Set(["error", "critical"]);

// ─── Normalisation ────────────────────────────────────────────────────────────

/** Collapse runs of whitespace (including newlines) to a single space, trim. */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ─── Locus extraction ─────────────────────────────────────────────────────────

/**
 * Extract candidate keywords from the flagged locus.
 * Uses the file basename (without extension) and the first identifier-like token
 * from the issue message. Both must be at least 3 chars to avoid false positives
 * on common short tokens like "is", "no", "at".
 */
function extractLocusKeywords(finding: AcQuotable): string[] {
  const keywords: string[] = [];

  // File basename without extension (e.g. "ac-quote-validator" from path)
  if (finding.file) {
    const basename = finding.file.split("/").pop() ?? "";
    const stem = basename.replace(/\.[^.]+$/, "");
    // Also try each dash/underscore segment as a keyword
    for (const part of stem.split(/[-_]/)) {
      if (part.length >= 3) keywords.push(part.toLowerCase());
    }
  }

  // First identifier-like token from the issue text (camelCase split + words)
  if (finding.issue) {
    const tokens = finding.issue
      .replace(/[`'"]/g, " ")
      .split(/[\s,.()\[\]{}:;]+/)
      .filter((t) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t) && t.length >= 3);
    // Include only the first few tokens — later tokens tend to be generic verbs
    for (const t of tokens.slice(0, 3)) {
      keywords.push(t.toLowerCase());
    }
  }

  return [...new Set(keywords)];
}

// ─── Core validator ───────────────────────────────────────────────────────────

/**
 * Validate a single LLM finding's acQuote against the story's acceptance criteria.
 *
 * Returns { valid: true } when:
 * - Severity is not blocking (warning / info / unverifiable) — no validation needed.
 * - acQuote is present, is a substring of the indexed AC, and contains a locus keyword.
 *
 * Returns { valid: false, code } otherwise.
 */
export function validateAcQuote(finding: AcQuotable, acceptanceCriteria: string[]): AcQuoteValidationResult {
  // Non-blocking severities bypass AC-quote validation
  if (!BLOCKING_SEVERITIES.has(finding.severity)) {
    return { valid: true };
  }

  const { acQuote, acIndex } = finding;

  if (!acQuote || typeof acQuote !== "string" || acQuote.trim() === "") {
    return { valid: false, code: "missing_ac_quote" };
  }

  if (typeof acIndex !== "number" || acIndex < 1 || acIndex > acceptanceCriteria.length) {
    return { valid: false, code: "ac_index_out_of_range" };
  }

  const acText = normalizeWs(acceptanceCriteria[acIndex - 1]);
  const normalizedQuote = normalizeWs(acQuote);

  if (!acText.toLowerCase().includes(normalizedQuote.toLowerCase())) {
    return { valid: false, code: "ac_quote_not_substring" };
  }

  const keywords = extractLocusKeywords(finding);
  if (keywords.length === 0) {
    return { valid: false, code: "ac_quote_does_not_constrain_locus" };
  }

  const quoteLower = normalizedQuote.toLowerCase();
  if (!keywords.some((kw) => quoteLower.includes(kw))) {
    return { valid: false, code: "ac_quote_does_not_constrain_locus" };
  }

  return { valid: true };
}

// ─── Batch filter ─────────────────────────────────────────────────────────────

export interface AcQuoteFilterResult<T extends AcQuotable> {
  /** Findings that passed validation (or were non-blocking, so skipped). */
  accepted: T[];
  /** Findings dropped due to failed validation. */
  dropped: { finding: T; code: AcQuoteRejectionCode }[];
}

/**
 * Filter a list of LLM findings, dropping blocking findings whose acQuote
 * fails validation. Non-blocking findings always pass through.
 */
export function filterByAcQuote<T extends AcQuotable>(
  findings: T[],
  acceptanceCriteria: string[],
): AcQuoteFilterResult<T> {
  const accepted: T[] = [];
  const dropped: { finding: T; code: AcQuoteRejectionCode }[] = [];

  for (const finding of findings) {
    const result = validateAcQuote(finding, acceptanceCriteria);
    if (result.valid) {
      accepted.push(finding);
    } else {
      dropped.push({ finding, code: result.code as AcQuoteRejectionCode });
    }
  }

  return { accepted, dropped };
}
