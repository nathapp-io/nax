/**
 * Shared severity rank table for review helpers.
 * Single source of truth used by both semantic-helpers.ts and adversarial-helpers.ts.
 */

export const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  unverifiable: 0,
  low: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

/**
 * Reviewer-finding severity. Loosened to `(string & {})` alongside the known
 * ranks (rather than a closed union) because LLM output is never fully
 * trusted — `SEVERITY_RANK[sev] ?? 0` already treats an unrecognized value as
 * rank 0, and the type should permit what the code actually accepts.
 */
export type Severity = keyof typeof SEVERITY_RANK | (string & {});

export function isBlockingSeverity(sev: string, threshold: "error" | "warning" | "info" = "error"): boolean {
  return (SEVERITY_RANK[sev] ?? 0) >= SEVERITY_RANK[threshold];
}
