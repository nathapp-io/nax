/**
 * Adversarial Review Helper Types and Utilities
 *
 * Private interfaces and parsing/formatting helpers extracted from adversarial.ts
 * to keep each file within the 600-line project limit.
 */

import type { Finding, FindingSeverity } from "../findings";
import { tryParseLLMJson } from "../utils/llm-json";
import { isBlockingSeverity } from "./severity";
export { isBlockingSeverity };

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
export function toAdversarialReviewFindings(findings: AdversarialLLMFinding[]): Finding[] {
  return findings.map((f) => ({
    source: "adversarial-review",
    severity: normalizeSeverity(f.severity),
    category: f.category,
    file: f.file,
    line: f.line,
    message: f.issue,
    suggestion: f.suggestion,
    fixTarget: f.category === "test-gap" ? "test" : undefined,
  }));
}
