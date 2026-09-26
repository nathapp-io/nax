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
 */

import type { Finding } from "@/findings";
import type { UserStory } from "@/prd";
import { wrapJsonPrompt } from "@/utils/llm-json";
import { buildReviewOutOfScopeBlock } from "../sections";

/** Everything the fix-review prompt is built from. */
export interface FixReviewPromptInput {
  readonly story: UserStory;
  /** The fix's own delta — already truncated by the runner. */
  readonly diff: string;
  /** The findings that seeded the fix. */
  readonly findings: readonly Finding[];
}

const FIX_REVIEW_ROLE =
  "You are a focused code reviewer. " +
  "Your job is to read only the fix's diff and judge whether it contradicts the story's acceptance criteria, " +
  "the story's design description, or an out-of-scope rule. " +
  "You do NOT re-review the whole story and you do NOT invent missing-work findings. " +
  "If the fix matches what it was supposed to do, pass it.";

const FIX_REVIEW_INSTRUCTIONS = `## Instructions

For each acceptance criterion and design rule in the prompt, ask: does any line of the embedded diff contradict it?
You may use Read / Glob / Grep to inspect the surrounding code when a diff line is ambiguous.

**Scope of review:** judge *only the fix's own edits*. Do not flag work the story was supposed to do but did NOT do —
that is the seeded reviewers' job. A diff that adds mkdir must fail only when an AC or out-of-scope rule forbids it.

**Contradiction rule:** a finding fires when an edit in the diff does the opposite of what an AC specifies,
violates a numbered rule in the design description, or crosses an out-of-scope boundary. Set \`acIndex\` to the
1-based number of the AC the diff contradicts. When the contradicted rule lives in \`description\` (design prose)
or in the out-of-scope list, omit \`acIndex\` and set \`file\` to the diff path the contradiction lives in.

Do NOT propose additional changes, refactors, lint fixes, naming improvements, or test coverage gaps.
Do NOT cite \`outOfScope\` as an acceptance criterion — \`acIndex\` must reference a numbered acceptance criterion
or be absent. Quote only the contradicted rule in \`reason\`; keep it under ~30 words.`;

const FIX_REVIEW_OUTPUT_SCHEMA = `Respond with JSON only — no explanation text before or after:

A pass verdict when the diff does not contradict any AC, description rule, or out-of-scope boundary:
{ "passed": true, "reason": "<one-sentence summary of why the fix is consistent>" }

A fail verdict when the diff contradicts a rule:
{ "passed": false, "reason": "<quote or paraphrase of the contradicted rule, ≤30 words>", "acIndex": 3, "file": "src/a.ts" }

Notes:
- \`acIndex\` is OPTIONAL. Set it ONLY when the contradicted rule is one of the numbered Acceptance Criteria above.
- \`file\` is OPTIONAL. Set it to the repo-root-relative path of the file the contradiction lives in.
- Omit both fields for a contradiction that names a description rule or an out-of-scope entry without an AC number.`;

/**
 * Build the verdict-only fix-review prompt.
 *
 * Renders: role + story (description + numbered acceptance criteria + out-of-scope
 * block) + seeding findings' messages + embedded diff + JSON verdict schema.
 */
export function buildFixReviewPrompt(input: FixReviewPromptInput): string {
  const { story, diff, findings } = input;

  // Numbered acceptance criteria — the 1-based index maps directly to `acIndex`
  // in the verdict. A two-digit index keeps its place (`10. ...`), which AC1's
  // boundary test asserts against.
  const acList = story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n");

  // Seeding findings — these are what the fix was meant to address. The reviewer
  // sees their messages so an answer that re-flags an old issue reads against
  // the diff that was meant to address it.
  const findingsBlock =
    findings.length === 0
      ? ""
      : `### Seeding findings (what this fix was meant to address)
${findings.map((f) => `- ${f.message}`).join("\n")}`;

  const core = `${FIX_REVIEW_ROLE}

## Story: ${story.title}

### Description
${story.description}

### Acceptance Criteria
${acList}
${buildReviewOutOfScopeBlock(story.outOfScope)}

${findingsBlock}
${FIX_REVIEW_INSTRUCTIONS}
${FIX_REVIEW_OUTPUT_SCHEMA}

### Fix diff

\`\`\`diff
${diff}
\`\`\``;

  return wrapJsonPrompt(core);
}
