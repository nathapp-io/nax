/**
 * Adversarial Review Helper Types and Utilities
 *
 * Private interfaces and parsing/formatting helpers extracted from adversarial.ts
 * to keep each file within the 600-line project limit.
 */

import type { Finding } from "../findings";
import { tryParseLLMJson } from "../utils/llm-json";
import { extractAcks } from "./acks";
import { categoryToFixTarget, resolveFixTarget } from "./category-fix-target";
import type { Severity } from "./severity";
import { isBlockingSeverity, normalizeSeverity } from "./severity";
import type { ReviewAck } from "./types";

export { isBlockingSeverity, normalizeSeverity };

export interface AdversarialLLMFinding {
  severity: Severity;
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
   * `false` when the finding reports compliance rather than requesting a change —
   * the reviewer noting that the code correctly honoured a constraint. Omitted means
   * actionable. Read by the ADR-024 nbf seeding filter so a "no action needed"
   * finding cannot trigger a paid fix pass (#1359).
   */
  actionRequired?: boolean;
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
  /** Prior findings resolved or withdrawn this round (#1423). Absent when none. */
  acks?: ReviewAck[];
}

/**
 * Validate parsed JSON matches the expected adversarial LLM response shape.
 */
export function validateAdversarialShape(parsed: unknown): AdversarialLLMResponse | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (!Array.isArray(obj.findings)) return null;
  const acks = extractAcks(obj.acks);
  return {
    passed: obj.passed,
    // Mirrors semantic-helpers.ts's validateLLMShape: `findings: [null]` and
    // `findings: ["prose"]` are both shapes an LLM produces, and every downstream
    // reader (e.g. filterByAcQuote) dereferences `.severity` unguarded — a malformed
    // entry that survives this cast becomes a crash mid-review (BUG-49).
    findings: (obj.findings as unknown[]).filter(isAdversarialFindingShaped).map(withNormalizedSeverity),
    ...(acks.length > 0 && { acks }),
  };
}

/** A finding must at least be an object; field-level validity is the consumer's business. */
function isAdversarialFindingShaped(f: unknown): f is AdversarialLLMFinding {
  return typeof f === "object" && f !== null && !Array.isArray(f);
}

/**
 * Copy a finding with its severity canonicalised (BUG-2), at the parse
 * boundary, so every downstream reader of the raw `AdversarialLLMFinding[]`
 * sees a canonical value.
 */
function withNormalizedSeverity(f: AdversarialLLMFinding): AdversarialLLMFinding {
  return { ...f, severity: normalizeSeverity(f.severity) };
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
      // Only forwarded when the reviewer said `false`; absent stays absent so the
      // "absent means actionable" default is not silently materialised (#1359).
      ...(f.actionRequired === false ? { actionRequired: false } : {}),
      meta: Object.keys(metaExtras).length > 0 ? metaExtras : undefined,
    };
  });
}
