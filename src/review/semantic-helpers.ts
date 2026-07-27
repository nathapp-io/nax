/**
 * Shared types and pure utility functions for the semantic review runner.
 * Extracted from semantic.ts to stay within the 600-line file limit.
 */

import type { Finding, FindingSeverity } from "../findings";
import { tryParseLLMJson } from "../utils/llm-json";
import { resolveFixTarget } from "./category-fix-target";
import { SEVERITY_RANK, isBlockingSeverity } from "./severity";
export { isBlockingSeverity };
import type { SemanticReviewConfig } from "./types";

export interface LLMFinding {
  severity: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
  acId?: string;
  /**
   * Optional advisory metadata: the AC bullet text the model believes constrains
   * this finding. Surfaced in audit logs for human review. NOT validated — see
   * `validateAcGroundingMinimal`. The blocking contract is `acIndex` only.
   */
  acQuote?: string;
  /** 1-based index into story.acceptanceCriteria corresponding to acQuote. */
  acIndex?: number;
  verifiedBy?: {
    command?: string;
    file: string;
    line?: number;
    observed: string;
  };
}

export interface LLMResponse {
  passed: boolean;
  findings: LLMFinding[];
}

export function validateLLMShape(parsed: unknown): LLMResponse | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.passed !== "boolean") return null;
  if (!Array.isArray(obj.findings)) return null;
  return { passed: obj.passed, findings: obj.findings as LLMFinding[] };
}

export function parseLLMResponse(raw: string): LLMResponse | null {
  try {
    return validateLLMShape(tryParseLLMJson(raw));
  } catch {
    return null;
  }
}

export function formatFindings(findings: LLMFinding[]): string {
  return findings
    .map((f) => `[${f.severity}] ${f.file}:${f.line} — ${f.issue}\n  Suggestion: ${f.suggestion}`)
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

export const UNVERIFIED_FINDING_PATTERNS = [
  "cannot verify",
  "can't verify",
  "from diff alone",
  "missing from diff",
  "not found in diff",
  "not present in diff",
  "does not appear in diff",
] as const;

/** Ref-mode semantic errors must prove they were verified against current files. */
export function sanitizeRefModeFindings(
  findings: LLMFinding[],
  diffMode: SemanticReviewConfig["diffMode"],
  blockingThreshold: "error" | "warning" | "info" = "error",
): LLMFinding[] {
  if (diffMode !== "ref") return findings;
  return findings.map((finding) =>
    needsDowngradeForMissingEvidence(finding, blockingThreshold) ? downgradeToUnverifiable(finding) : finding,
  );
}

function needsDowngradeForMissingEvidence(
  finding: LLMFinding,
  blockingThreshold: "error" | "warning" | "info",
): boolean {
  if (!isBlockingSeverity(finding.severity, blockingThreshold)) return false;
  return mentionsUnverifiedSource(finding) || !hasVerifiedEvidence(finding);
}

function mentionsUnverifiedSource(finding: LLMFinding): boolean {
  const text = `${finding.issue} ${finding.suggestion}`.toLowerCase();
  return UNVERIFIED_FINDING_PATTERNS.some((pattern) => text.includes(pattern));
}

function hasVerifiedEvidence(finding: LLMFinding): boolean {
  const evidence = finding.verifiedBy;
  return !!evidence?.file?.trim() && !!evidence.observed?.trim();
}

function downgradeToUnverifiable(finding: LLMFinding): LLMFinding {
  return {
    ...finding,
    severity: "unverifiable",
  };
}

/** Options shared by the semantic Finding converters. */
export interface SemanticFindingOptions {
  /**
   * Test-file classifier from `resolveTestFilePatterns` (ADR-009 SSOT). Semantic
   * findings default to the source lane, but a finding *about a test file* can
   * only be fixed by the test-writer — routing it to the implementer, which may
   * not edit tests, deadlocks the fix cycle (#1368).
   */
  isTestFile?: (path: string) => boolean;
}

/** Convert a single LLMFinding to the unified Finding wire format. */
export function llmFindingToFinding(f: LLMFinding, opts: SemanticFindingOptions = {}): Finding {
  const metaExtras: Record<string, unknown> = {};
  if (f.verifiedBy) metaExtras.verifiedBy = f.verifiedBy;
  if (f.acQuote) metaExtras.acQuote = f.acQuote;
  if (f.acIndex != null) metaExtras.acIndex = f.acIndex;
  return {
    source: "semantic-review",
    severity: normalizeSeverity(f.severity),
    category: "",
    file: f.file,
    line: f.line,
    message: f.issue,
    suggestion: f.suggestion ?? undefined,
    fixTarget: resolveFixTarget({ base: "source", file: f.file, isTestFile: opts.isTestFile }),
    meta: Object.keys(metaExtras).length > 0 ? metaExtras : undefined,
  };
}

/** Convert LLMFinding[] to Finding[] with semantic-review source. */
export function toReviewFindings(findings: LLMFinding[], opts: SemanticFindingOptions = {}): Finding[] {
  return findings.map((f) => llmFindingToFinding(f, opts));
}
