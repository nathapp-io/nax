import type { Finding, FindingSeverity, FixTarget } from "../types";

/**
 * Convert one raw finding record from the acceptance diagnose LLM output into
 * the normalized Finding format. Returns null when required fields are missing.
 */
export function acceptanceDiagnoseRawToFinding(raw: Record<string, unknown>): Finding | null {
  if (typeof raw.message !== "string" || typeof raw.category !== "string") {
    return null;
  }

  return {
    source: "acceptance-diagnose",
    severity: (typeof raw.severity === "string" ? raw.severity : "error") as FindingSeverity,
    category: String(raw.category),
    message: String(raw.message),
    fixTarget: (raw.fixTarget as FixTarget | undefined) ?? undefined,
    file: typeof raw.file === "string" ? raw.file : undefined,
    line: typeof raw.line === "number" ? raw.line : undefined,
    suggestion: typeof raw.suggestion === "string" ? raw.suggestion : undefined,
  };
}

/**
 * Convert raw acceptance diagnose findings into normalized findings, dropping
 * malformed records. Returns an empty array for non-array inputs.
 */
export function acceptanceDiagnoseRawArrayToFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((record): record is Record<string, unknown> => record !== null && typeof record === "object")
    .map(acceptanceDiagnoseRawToFinding)
    .filter((finding): finding is Finding => finding !== null);
}
