/**
 * Test-Quality Section — adversarial test-gap pre-brief.
 *
 * July 2026 audit: test-gap was 67% of adversarial blocking findings, and each
 * one cost a review round plus a rectification round (~43.6% of total spend was
 * rectification). The adversarial reviewer's "Test Audit Gap" heuristics
 * describe exactly what it rejects — this section forwards them to the roles
 * that AUTHOR tests, so the knowledge arrives before the tests are written.
 *
 * Kept deliberately compact (<1600 chars): this is a token-saving measure and
 * must not become a token sink. The full lens catalogue stays in
 * adversarial-review-builder.ts; only the rejection criteria are pre-briefed.
 */

import type { PromptRole } from "../core";

/** Roles that author tests unconditionally. */
const AUTHORING_ROLES: ReadonlySet<PromptRole> = new Set(["test-writer", "single-session", "tdd-simple", "batch"]);

/**
 * Build the review-proof-tests pre-brief for test-authoring roles.
 *
 * Returns "" for roles that do not author tests. The `implementer` role
 * authors tests only in its "lite" variant (session 2 of three-session-tdd-lite
 * fills AC coverage gaps), so it receives the section only then.
 */
export function buildTestQualitySection(role: PromptRole, variant?: "standard" | "lite", storyId?: string): string {
  const authors = AUTHORING_ROLES.has(role) || (role === "implementer" && variant === "lite");
  if (!authors) return "";

  const storyIdLine = storyId
    ? `\n- Test names must use THIS story's ID (${storyId}) — never a sibling story's ID copied from a nearby test.`
    : "";

  return `## Review-Proof Tests

An adversarial reviewer will audit your tests after implementation and BLOCK the story on any test-gap finding. Each block costs a full rectification round. Write tests that survive that audit the first time:

- Every acceptance criterion needs a test that INVOKES the code at runtime and asserts its observable behavior (return value, thrown error, rendered/mounted output, emitted event, persisted state).
- NEVER write source-inspection tests — asserting that a file contains a pattern, string, or symbol proves nothing about behavior and WILL be blocked as test-gap.
- No placeholder or tautological tests: \`expect(true).toBe(true)\`, asserting on literals, empty bodies, \`.skip\`/\`.todo\` on an AC-covering test — all blocked as test-gap.
- Every new exported symbol must be exercised by at least one test.
- Cover the boundary and error paths the reviewer probes: empty/null/zero/negative inputs, and failure modes (errors must surface, not be swallowed).
- For UI/page-level ACs, mount the page/component and simulate the interaction — testing only the underlying unit leaves the wiring unaudited.${storyIdLine}`;
}
