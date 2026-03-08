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
- All tests pass
- Implementation is clean and follows conventions
- All acceptance criteria met
- Any test modifications by implementer are legitimate fixes

Set \`approved: false\` when ANY of these conditions are true:
- Tests are failing and you cannot fix them
- The implementer loosened test assertions to mask bugs
- Critical acceptance criteria are not met
- Code quality is poor (security issues, severe bugs, etc.)

**Full JSON schema example** (fill in all fields with real values):

\`\`\`json
{
  "version": 1,
  "approved": true,
  "tests": {
    "allPassing": true,
    "passCount": 42,
    "failCount": 0
  },
  "testModifications": {
    "detected": false,
    "files": [],
    "legitimate": true,
    "reasoning": "No test files were modified by the implementer"
  },
  "acceptanceCriteria": {
    "allMet": true,
    "criteria": [
      { "criterion": "Example criterion", "met": true }
    ]
  },
  "quality": {
    "rating": "good",
    "issues": []
  },
  "fixes": [],
  "reasoning": "All tests pass, implementation is clean, all acceptance criteria are met."
}
\`\`\`

**Field notes:**
- \`quality.rating\` must be one of: \`"good"\`, \`"acceptable"\`, \`"poor"\`
- \`testModifications.files\` — list any test files the implementer changed
- \`fixes\` — list any fixes you applied yourself during this verification session
- \`reasoning\` — brief summary of your overall assessment

When done, commit any fixes with message: "fix: verify and adjust ${story.title}"`;
}
