/**
 * Verdict Section
 *
 * Verifier verdict JSON schema instructions (non-overridable).
 * Provides instructions for writing the .nax-verifier-verdict.json file.
 */

import type { UserStory } from "../../prd/types";

export function buildVerdictSection(story: UserStory): string {
  return `# Verdict Instructions

## Write Verdict File

After completing your verification, you **MUST** write a verdict file at the **project root**:

**File:** \`.nax-verifier-verdict.json\`

Set \`approved: true\` when ALL of these conditions are met:
- All story-scoped tests pass (the orchestrator already attempted the full-suite gate — you only need to verify the story's own tests)
- Any test modifications by implementer are legitimate fixes

Set \`approved: false\` when ANY of these conditions are true:
- Tests are failing and you cannot fix them
- The implementer loosened test assertions to mask bugs
- The implementer made illegitimate test changes

**JSON schema** (fill in all fields with real values):

\`\`\`json
{"version":1,"approved":true,"tests":{"allPassing":true,"passCount":42,"failCount":0},"testModifications":{"detected":false,"files":[],"legitimate":true,"reasoning":"..."},"acceptanceCriteria":{"allMet":true,"criteria":[{"criterion":"...","met":true}]},"quality":{"rating":"good","issues":[]},"fixes":[],"reasoning":"..."}
\`\`\`

**Field notes:**
- \`quality.rating\` must be one of: \`"good"\`, \`"acceptable"\`, \`"poor"\`
- \`testModifications.files\` — list any test files the implementer changed
- \`acceptanceCriteria\` and \`quality\` are advisory in this TDD verifier verdict; do not use them to reject semantic correctness
- \`fixes\` — keep this empty; the verifier must not apply code or test fixes
- \`reasoning\` — brief summary of your overall assessment

When done, do not commit code changes. Only write the verdict file.`;
}
