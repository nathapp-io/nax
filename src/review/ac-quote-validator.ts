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
  /**
   * Adversarial finding category. When `"test-gap"`, the locus-keyword check is
   * waived: a test-gap is the *absence* of a verifying test for an AC's behaviour,
   * so its acQuote is grounded by the AC it covers — not by a symbol present in
   * the (fake/placeholder) test file. Without this waiver, a genuinely fake test
   * (`expect(true).toBe(true)` covering AC-N) is dropped as
   * `ac_quote_does_not_constrain_locus` and the story passes. See
   * docs/findings/2026-05-30-prompt-audit-analysis.md (#2).
   */
  category?: string;
  /** Verbatim substring of the `outOfScope` entry at `scopeIndex` (scope findings only). */
  scopeQuote?: string;
  /** 1-based index into story.outOfScope corresponding to `scopeQuote`. */
  scopeIndex?: number;
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

  // test-gap carve-out: a fake/placeholder/missing test is the absence of a
  // verifying symbol, so it cannot — and must not be required to — name a symbol
  // present in the test file. Grounding by a valid acIndex + AC substring is
  // sufficient. This lets adversarial review block stories whose ACs are
  // "covered" only by tautological tests. (#2 / 2026-05-30 prompt-audit analysis.)
  //
  // `category` is LLM-controlled, so this only RELAXES the locus check — never
  // evidence. A finding mislabelled "test-gap" still needs a valid acIndex +
  // verbatim AC substring here, and still passes through verifiedBy / evidence
  // substantiation in the op's verify(). Mislabelling makes a finding more
  // likely to block (stricter), never bypass-to-pass.
  if (finding.category === "test-gap") {
    return { valid: true };
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

// ─── Scope-grounding validator ────────────────────────────────────────────────

/** Shortest quote that can meaningfully ground a scope finding. */
const MIN_SCOPE_QUOTE_LENGTH = 3;

export type ScopeQuoteRejectionCode =
  | "missing_scope_quote"
  | "scope_index_out_of_range"
  | "scope_quote_not_substring"
  | "no_out_of_scope_declared";

export interface ScopeQuoteValidationResult {
  valid: boolean;
  code?: ScopeQuoteRejectionCode;
}

/**
 * A finding claims a scope boundary only when its category says so.
 *
 * Deliberately NOT keyed on `scopeQuote !== undefined`: the field is advertised
 * at the top level of the output schema, so models volunteer it opportunistically
 * on unrelated findings. Treating a stray paraphrased `scopeQuote` as a scope
 * claim would drop an otherwise valid, AC-grounded, evidence-substantiated
 * blocking finding — the story would pass with the only trace a log line about a
 * scope quote. A stray citation on a non-scope finding is stripped instead
 * (see {@link filterByScopeQuote}).
 */
function claimsScopeViolation(finding: AcQuotable): boolean {
  return finding.category === "out-of-scope";
}

/**
 * Validate a scope-violation finding against the story's declared exclusions.
 *
 * Unlike {@link validateAcQuote}, this runs at **every** severity. Scope findings
 * are capped at `"warning"` by the reviewer prompt, so a blocking-severity gate
 * would never fire — yet an ungrounded scope finding still does damage: it lands
 * in the story report and in the next tier's escalation context, where a
 * fabricated "you violated boundary X" reads as fact.
 *
 * A finding that cites the numbered `outOfScope` list must quote it verbatim.
 * A scope finding with no `scopeQuote` at all is valid — the reviewer is allowed
 * to report a description-level `Scope — Out:` bullet, which is prose the
 * validator has no numbered list to check against.
 */
export function validateScopeQuote(finding: AcQuotable, outOfScope: readonly string[]): ScopeQuoteValidationResult {
  if (!claimsScopeViolation(finding)) return { valid: true };

  const { scopeQuote, scopeIndex } = finding;

  // No citation offered → a description-level scope bullet. Nothing to verify.
  if (scopeQuote === undefined) return { valid: true };

  // Minimum length mirrors the >=3-char locus rule in validateAcQuote: a 1-2
  // char quote is a substring of almost any entry and grounds nothing.
  if (typeof scopeQuote !== "string" || scopeQuote.trim().length < MIN_SCOPE_QUOTE_LENGTH) {
    return { valid: false, code: "missing_scope_quote" };
  }
  if (outOfScope.length === 0) {
    return { valid: false, code: "no_out_of_scope_declared" };
  }
  if (typeof scopeIndex !== "number" || scopeIndex < 1 || scopeIndex > outOfScope.length) {
    return { valid: false, code: "scope_index_out_of_range" };
  }

  const entry = normalizeWs(stripMarkdownInline(outOfScope[scopeIndex - 1]));
  const quote = normalizeWs(stripMarkdownInline(scopeQuote));
  if (!entry.toLowerCase().includes(quote.toLowerCase())) {
    return { valid: false, code: "scope_quote_not_substring" };
  }

  return { valid: true };
}

export interface ScopeQuoteFilterResult<T extends AcQuotable> {
  /** Findings that passed validation (or made no scope claim, so were skipped). */
  accepted: T[];
  /** Scope findings dropped because their citation could not be grounded. */
  dropped: AcDroppedEntry<T, ScopeQuoteRejectionCode>[];
}

/**
 * Drop scope-violation findings whose `scopeQuote` cannot be grounded in the
 * story's `outOfScope` list. Findings making no scope claim pass through
 * untouched — this filter never inspects an AC-grounded finding.
 */
export function filterByScopeQuote<T extends AcQuotable>(
  findings: T[],
  outOfScope: readonly string[],
): ScopeQuoteFilterResult<T> {
  const accepted: T[] = [];
  const dropped: AcDroppedEntry<T, ScopeQuoteRejectionCode>[] = [];

  for (const finding of findings) {
    if (!claimsScopeViolation(finding)) {
      // Not a scope finding. If it volunteered a scope citation anyway, strip the
      // unverified fields so nothing downstream treats them as grounding — but
      // never drop the finding over them; its own AC grounding is what counts.
      accepted.push(
        finding.scopeQuote === undefined && finding.scopeIndex === undefined
          ? finding
          : { ...finding, scopeQuote: undefined, scopeIndex: undefined },
      );
      continue;
    }
    const result = validateScopeQuote(finding, outOfScope);
    if (result.valid) {
      accepted.push(finding);
    } else {
      dropped.push({ finding, code: result.code as ScopeQuoteRejectionCode });
    }
  }

  return { accepted, dropped };
}
