/**
 * Shared severity rank table for review helpers.
 * Single source of truth used by both semantic-helpers.ts and adversarial-helpers.ts.
 */

export const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  unverifiable: 0,
  low: 1,
  warning: 1,
  error: 2,
  critical: 3,
};

export function isBlockingSeverity(sev: string, threshold: "error" | "warning" | "info" = "error"): boolean {
  return (SEVERITY_RANK[sev] ?? 0) >= SEVERITY_RANK[threshold];
}
