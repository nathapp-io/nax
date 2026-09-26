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
  | "repo-scoped-test-fix"
  | "verifier"
  | "diagnose"
  | "source-fix"
  | "test-fix"
  | "reviewer-semantic"
  | "reviewer-adversarial"
  /**
   * US-001 — the scoped fix review's own fresh reviewer session. RED stub: the
   * TYPE member is declared so callers and fixtures compile; the runtime
   * registry below still has to gain the same value (`isSessionRole` reads
   * `KNOWN_SESSION_ROLES`, not this union).
   */
  | "reviewer-fix"
  | "plan"
  | "plan-refine"
  | "decompose"
  | "acceptance-gen"
  | "refine"
  | "fix-gen"
  | "auto"
  | "setup"
  | "finish-review-spec"
  | "finish-review-quality"
  | "finish-fix"
  | "finish-narrative";

export type SessionRole = CanonicalSessionRole;

export const KNOWN_SESSION_ROLES: readonly CanonicalSessionRole[] = [
  "main",
  "test-writer",
  "implementer",
  "repo-scoped-test-fix",
  "verifier",
  "diagnose",
  "source-fix",
  "test-fix",
  "reviewer-semantic",
  "reviewer-adversarial",
  "plan",
  "plan-refine",
  "decompose",
  "acceptance-gen",
  "refine",
  "fix-gen",
  "auto",
  "setup",
  "finish-review-spec",
  "finish-review-quality",
  "finish-fix",
  "finish-narrative",
] as const;

export function isSessionRole(s: string): s is SessionRole {
  return (KNOWN_SESSION_ROLES as readonly string[]).includes(s);
}
