/**
 * Shared severity rank table for review helpers.
 * Single source of truth used by both semantic-helpers.ts and adversarial-helpers.ts.
 */

// `as const satisfies` (not `: Record<string, number>`) so `keyof typeof SEVERITY_RANK`
// below is the literal key union, not `string` — a plain type annotation here would
// make `Severity` collapse to `string` and defeat the point of the alias.
export const SEVERITY_RANK = {
  info: 0,
  unverifiable: 0,
  low: 1,
  warning: 2,
  error: 3,
  critical: 4,
} as const satisfies Record<string, number>;

/**
 * Reviewer-finding severity. Loosened to `(string & {})` alongside the known
 * ranks (rather than a closed union) because LLM output is never fully
 * trusted — `isBlockingSeverity` already treats an unrecognized value as rank
 * 0, and the type should permit what the code actually accepts.
 */
export type Severity = keyof typeof SEVERITY_RANK | (string & {});

export function isBlockingSeverity(sev: string, threshold: "error" | "warning" | "info" = "error"): boolean {
  const rank = (SEVERITY_RANK as Record<string, number>)[sev] ?? 0;
  return rank >= SEVERITY_RANK[threshold];
}
