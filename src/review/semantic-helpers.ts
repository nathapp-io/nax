/**
 * Shared types and pure utility functions for the semantic review runner.
 * Extracted from semantic.ts to stay within the 600-line file limit.
 */

import type { ReviewFinding } from "../plugins/types";
import { tryParseLLMJson } from "../utils/llm-json";
import type { SemanticReviewConfig } from "./types";

export interface LLMFinding {
  severity: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
  acId?: string;
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

/** Normalize LLM severity values to ReviewFinding severity union. */
export function normalizeSeverity(sev: string): ReviewFinding["severity"] {
  if (sev === "warn") return "warning";
  if (sev === "unverifiable") return "info";
  if (sev === "critical" || sev === "error" || sev === "warning" || sev === "info" || sev === "low") return sev;
  return "info";
}

export const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  unverifiable: 0,
  low: 1,
  warning: 1,
  error: 2,
  critical: 3,
};

export const UNVERIFIED_FINDING_PATTERNS = [
  "cannot verify",
  "can't verify",
  "from diff alone",
  "missing from diff",
  "not found in diff",
  "not present in diff",
  "does not appear in diff",
] as const;

export function isBlockingSeverity(sev: string, threshold: "error" | "warning" | "info" = "error"): boolean {
  return (SEVERITY_RANK[sev] ?? 0) >= (SEVERITY_RANK[threshold] ?? 2);
}

/** Ref-mode semantic errors must prove they were verified against current files. */
export function sanitizeRefModeFindings(
  findings: LLMFinding[],
  diffMode: SemanticReviewConfig["diffMode"],
): LLMFinding[] {
  if (diffMode !== "ref") return findings;
  return findings.map((finding) =>
    needsDowngradeForMissingEvidence(finding) ? downgradeToUnverifiable(finding) : finding,
  );
}

function needsDowngradeForMissingEvidence(finding: LLMFinding): boolean {
  if ((SEVERITY_RANK[finding.severity] ?? 0) < SEVERITY_RANK.error) return false;
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

/** Convert LLMFinding[] to ReviewFinding[] with semantic-review metadata. */
export function toReviewFindings(findings: LLMFinding[]): ReviewFinding[] {
  return findings.map((f) => ({
    ruleId: "semantic",
    severity: normalizeSeverity(f.severity),
    file: f.file,
    line: f.line,
    message: f.issue,
    source: "semantic-review",
  }));
}
