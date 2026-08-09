/**
 * Verdict Section
 *
 * Verifier verdict JSON schema instructions (non-overridable).
 * Provides instructions for writing the .nax-verifier-verdict.json file.
 */

import type { UserStory } from "../../prd/types";

export function buildVerdictSection(story: UserStory): string {
  return `# Verdict Instructions

## Write Verdict File and Emit JSON in Final Reply

After completing your verification, you **MUST** do BOTH of the following:

1. Write the verdict file at the **project root**: \`.nax-verifier-verdict.json\`
2. Emit the same verdict JSON as the FINAL content of your reply — no prose
   before or after, no markdown fences. Your reply must end with a closing
   brace \`}\` on its own line. The orchestrator parses your reply as JSON.

Set \`approved: true\` when ALL of these conditions are met:
- All story-scoped tests pass (the orchestrator already attempted the full-suite gate — you only need to verify the story's own tests)
- Any test modifications by implementer are legitimate fixes

Set \`approved: false\` when ANY of these conditions are true:
- Tests are failing and you cannot fix them
- The implementer loosened test assertions to mask bugs
- The implementer made illegitimate test changes

When tests fail but the implementation satisfies every acceptance criterion and
a specific test assertion contradicts the specification, set
\`testFailureDiagnosis.cause\` to \`"test-incorrect"\` and identify each
assertion with its file, test name, and reasoning. Do not use this diagnosis if
the implementer modified tests or any acceptance criterion is unmet.

**JSON schema** (fill in all fields with real values):

\`\`\`json
{"version":1,"approved":true,"tests":{"allPassing":true,"passCount":42,"failCount":0},"testModifications":{"detected":false,"files":[],"legitimate":true,"reasoning":"..."},"testFailureDiagnosis":null,"acceptanceCriteria":{"allMet":true,"criteria":[{"criterion":"...","met":true}]},"quality":{"rating":"good","issues":[]},"fixes":[],"reasoning":"..."}
\`\`\`

**Field notes:**
- \`quality.rating\` must be one of: \`"good"\`, \`"acceptable"\`, \`"poor"\`
- \`testModifications.files\` — list any test files the implementer changed
- \`testFailureDiagnosis\` — normally \`null\`; for a concrete incorrect-test
  diagnosis use \`{"cause":"test-incorrect","assertions":[{"file":"...","testName":"...","reasoning":"..."}]}\`
- \`acceptanceCriteria\` and \`quality\` are advisory in this TDD verifier verdict; do not use them to reject semantic correctness
- \`fixes\` — keep this empty; the verifier must not apply code or test fixes
- \`reasoning\` — brief summary of your overall assessment

When done, do not commit code changes. Write the verdict file, then end your reply with the JSON object.`;
}
