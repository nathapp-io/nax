/**
 * Fix-review prompt builder (US-003, ADR-033).
 *
 * Builds the prompt for the verdict-only review of a *fix's own delta* — the
 * scoped check the NBF keep gate runs before keeping a best-effort pass. Unlike
 * the seeded semantic/adversarial reviewers, this one never re-reads the whole
 * story: it judges the embedded fix diff against the story's acceptance
 * criteria (numbered from 1), the story's `description` (where the planner
 * carries design prose — the #2229 "neither the data file nor its parent
 * directory is created" rule lives only there), the feature-level `outOfScope`
 * block, and the messages of the findings that seeded the fix.
 *
 * The response is one JSON verdict:
 *   `{ "passed": false, "reason": "...", "acIndex": 4, "file": "src/a.ts" }`
 * where `acIndex` (1-based into the acceptance criteria) and `file` are set
 * only when the contradicted rule is an acceptance criterion.
 *
 * RED STUB (US-003 test-writer session): the body returns an empty placeholder
 * so AC1-AC5 fail on their assertions rather than on a throw or an import. The
 * implementer assembles the real prompt.
 */

import type { Finding } from "@/findings";
import type { UserStory } from "@/prd";

/** Everything the fix-review prompt is built from. */
export interface FixReviewPromptInput {
  readonly story: UserStory;
  /** The fix's own delta — already truncated by the runner. */
  readonly diff: string;
  /** The findings that seeded the fix. */
  readonly findings: readonly Finding[];
}

export function buildFixReviewPrompt(_input: FixReviewPromptInput): string {
  return "";
}
