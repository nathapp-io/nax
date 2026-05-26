/**
 * AC Grounding Validators
 *
 * Two validation strategies for reviewer "error" findings:
 *
 * **Adversarial path (Issue #930):** validateAcQuote / filterByAcQuote
 * - Requires acQuote to be a whitespace-normalised substring of the indexed AC
 * - Requires acQuote to contain a locus keyword (file basename or issue token)
 * - Used by src/review/adversarial.ts
 *
 * **Semantic path (Issue #985):** validateAcGroundingMinimal / filterByAcGroundingMinimal
 * - Requires only a valid acIndex (1-based, in range)
 * - acQuote is advisory metadata, never inspected
 * - Used by src/review/semantic.ts and semantic-debate.ts
 *
 * Ungrounded findings are dropped before they can block a story or bias
 * next-tier escalation context.
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

export interface AcDroppedEntry<F, C> {
  finding: F;
  code: C;
}

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

/**
 * Strip inline markdown formatting (backticks, bold, italic) for substring matching.
 *
 * The AC-quote validator's purpose is to confirm the model cited real AC text, not to
 * enforce markdown formatting fidelity. LLMs routinely drop backtick spans when quoting
 * — this normalisation prevents false `ac_quote_not_substring` rejections caused solely
 * by backtick presence/absence.
 */
function stripMarkdownInline(s: string): string {
  return s.replace(/`/g, "").replace(/\*\*/g, "").replace(/\*/g, "");
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

  const acText = normalizeWs(stripMarkdownInline(acceptanceCriteria[acIndex - 1]));
  const normalizedQuote = normalizeWs(stripMarkdownInline(acQuote));

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
  dropped: AcDroppedEntry<T, AcQuoteRejectionCode>[];
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
  const dropped: AcDroppedEntry<T, AcQuoteRejectionCode>[] = [];

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

// ─── Minimal validator (Issue #985) ───────────────────────────────────────────

export type AcGroundingMinimalRejection = "missing_ac_index" | "ac_index_out_of_range";

export interface AcGroundingMinimalFilterResult<T extends AcQuotable> {
  /** Findings that passed validation (or were non-blocking, so skipped). */
  accepted: T[];
  /** Findings dropped due to missing or out-of-range acIndex. */
  dropped: AcDroppedEntry<T, AcGroundingMinimalRejection>[];
}

/**
 * Minimal AC-grounding validator for the semantic review path (Issue #985).
 *
 * Requires only a valid acIndex (1-based, in range). acQuote is advisory metadata
 * and is never inspected. Use validateAcQuote for the adversarial path.
 */
export function validateAcGroundingMinimal(
  finding: AcQuotable,
  acceptanceCriteria: string[],
): { valid: true } | { valid: false; code: AcGroundingMinimalRejection } {
  if (!BLOCKING_SEVERITIES.has(finding.severity)) {
    return { valid: true };
  }

  const { acIndex } = finding;

  if (typeof acIndex !== "number" || acIndex < 1) {
    return { valid: false, code: "missing_ac_index" };
  }

  if (acIndex > acceptanceCriteria.length) {
    return { valid: false, code: "ac_index_out_of_range" };
  }

  return { valid: true };
}

/**
 * Filter a list of LLM findings, dropping blocking findings whose acIndex
 * is absent or out of range. acQuote is never inspected. Non-blocking findings
 * always pass through.
 */
export function filterByAcGroundingMinimal<T extends AcQuotable>(
  findings: T[],
  acceptanceCriteria: string[],
): AcGroundingMinimalFilterResult<T> {
  const accepted: T[] = [];
  const dropped: AcDroppedEntry<T, AcGroundingMinimalRejection>[] = [];

  for (const finding of findings) {
    const result = validateAcGroundingMinimal(finding, acceptanceCriteria);
    if (result.valid) {
      accepted.push(finding);
    } else {
      dropped.push({ finding, code: result.code });
    }
  }

  return { accepted, dropped };
}
