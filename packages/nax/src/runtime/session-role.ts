/**
 * Canonical session role registry — SSOT for adapter-wiring.md Rule 2.
 * Promoting ADR-018 §9's template-literal union here so every consumer
 * (descriptor, handle, runOptions, completeOptions, DispatchEvent) shares
 * the same type. Free-form sessionRole strings are banned outside this
 * file; misspellings/legacy values become compile errors at the call site.
 *
 * One exception, by construction: the session contract carries the role on
 * `SessionHandle.role` as an opaque `string` (S1 spec section 4.2, port 2), so
 * the contract file permits exactly one free-form string. `knownSessionRole`
 * below is what narrows it back to this registry on the way in.
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
  /** US-001 — the scoped fix review's own fresh reviewer session. */
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
  | "finish-narrative"
  /** A1 — the advisor's read-only session. */
  | "advisor";

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
  "reviewer-fix",
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
  "advisor",
] as const;

export function isSessionRole(s: string): s is SessionRole {
  return (KNOWN_SESSION_ROLES as readonly string[]).includes(s);
}

/**
 * A handle's role narrowed to a role nax knows. The session contract carries
 * the role as an opaque string (S1 spec section 4.2, port 2); an unknown or
 * absent string reads as absent, so callers fall back to their own role.
 */
export function knownSessionRole(role: string | undefined): SessionRole | undefined {
  return role !== undefined && isSessionRole(role) ? role : undefined;
}
