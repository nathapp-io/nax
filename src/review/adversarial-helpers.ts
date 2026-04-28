/**
 * Adversarial Review Helper Types and Utilities
 *
 * Private interfaces and parsing/formatting helpers extracted from adversarial.ts
 * to keep each file within the 600-line project limit.
 */

import type { ReviewFinding } from "../plugins/types";
import { tryParseLLMJson } from "../utils/llm-json";
import { SEVERITY_RANK } from "./severity";

export interface AdversarialLLMFinding {
  severity: string;
  category: string;
  file: string;
  line: number;
  issue: string;
  suggestion: string;
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

/** Normalize LLM severity values to ReviewFinding severity union. */
export function normalizeSeverity(sev: string): ReviewFinding["severity"] {
  if (sev === "warn") return "warning";
  if (sev === "unverifiable") return "info";
  if (sev === "critical" || sev === "error" || sev === "warning" || sev === "info" || sev === "low") return sev;
  return "info";
}

/**
 * Check whether a normalized finding severity meets or exceeds the blocking threshold.
 * threshold defaults to "error" — only error/critical block unless configured stricter.
 */
export function isBlockingSeverity(sev: string, threshold: "error" | "warning" | "info" = "error"): boolean {
  return (SEVERITY_RANK[sev] ?? 0) >= (SEVERITY_RANK[threshold] ?? 2);
}

/** Convert AdversarialLLMFinding[] to ReviewFinding[] with adversarial-review metadata. */
export function toAdversarialReviewFindings(findings: AdversarialLLMFinding[]): ReviewFinding[] {
  return findings.map((f) => ({
    ruleId: "adversarial",
    severity: normalizeSeverity(f.severity),
    file: f.file,
    line: f.line,
    message: f.issue,
    source: "adversarial-review",
    category: f.category,
  }));
}
