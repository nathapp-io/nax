/**
 * Canonical session role registry — SSOT for adapter-wiring.md Rule 2.
 * Promoting ADR-018 §9's template-literal union here so every consumer
 * (descriptor, handle, runOptions, completeOptions, DispatchEvent) shares
 * the same type. Free-form sessionRole strings are banned outside this
 * file; misspellings/legacy values become compile errors at the call site.
 */

export type CanonicalSessionRole =
  | "main"
  | "test-writer"
  | "implementer"
  | "verifier"
  | "diagnose"
  | "source-fix"
  | "test-fix"
  | "reviewer-semantic"
  | "reviewer-adversarial"
  | "plan"
  | "decompose"
  | "acceptance-gen"
  | "refine"
  | "fix-gen"
  | "auto"
  | "synthesis"
  | "judge";

export type SessionRole = CanonicalSessionRole | `debate-${string}`;

export const KNOWN_SESSION_ROLES: readonly CanonicalSessionRole[] = [
  "main",
  "test-writer",
  "implementer",
  "verifier",
  "diagnose",
  "source-fix",
  "test-fix",
  "reviewer-semantic",
  "reviewer-adversarial",
  "plan",
  "decompose",
  "acceptance-gen",
  "refine",
  "fix-gen",
  "auto",
  "synthesis",
  "judge",
] as const;

export function isSessionRole(s: string): s is SessionRole {
  if ((KNOWN_SESSION_ROLES as readonly string[]).includes(s)) return true;
  return s.startsWith("debate-") && s.length > 7;
}
