import { executionGatesConfigSelector } from "../config";
import type { SessionRole } from "../session/types";

export { executionGatesConfigSelector };

/** Minimal config shape consumed by execution gate helpers. */
type GatesConfig = {
  review?: { enabled?: boolean };
  execution?: { rectification?: { enabled?: boolean } };
};

/** Returns true when the review stage is enabled. */
export function shouldRunReview(config: GatesConfig): boolean {
  return config.review?.enabled === true;
}

/** Returns true when the rectification stage is enabled. */
export function shouldRunRectification(config: GatesConfig): boolean {
  return config.execution?.rectification?.enabled === true;
}

/**
 * Roles whose ACP session is kept open across fix stages so the agent retains memory of
 * what it produced: the implementer (the code it wrote) and the test-writer (the tests it
 * wrote — resumed by autofix-test-writer). Verifier and reviewers are one-shot, so they
 * stay fresh. Extends the implementer-only session continuity of ADR-007/008 to the
 * test-writer; see docs/adr/ADR-008.
 */
const SESSION_CONTINUITY_ROLES = new Set<SessionRole>(["implementer", "test-writer"]);

/**
 * Returns true when the role's session must stay open after the agent turn so a later fix
 * stage (review / rectification) can resume it with full context.
 */
export function shouldKeepSessionOpen(config: GatesConfig, role: SessionRole): boolean {
  return SESSION_CONTINUITY_ROLES.has(role) && (shouldRunReview(config) || shouldRunRectification(config));
}
