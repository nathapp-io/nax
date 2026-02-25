import type { UserStory } from "../prd";
import type { TddSessionRole } from "./types";

/**
 * Prompt to build the TDD agent's role definition
 */
export function buildTddRolePrompt(
  role: TddSessionRole,
  story: UserStory,
  config?: { projectRoot: string },
  currentBranch?: string,
): string {
  const common = `You are a TDD agent (role: ${role}) working on the story: "${story.title}".${config ? `\nProject root: ${config.projectRoot}` : ""}${currentBranch ? `\nCurrent branch: ${currentBranch}` : ""}

STORY DESCRIPTION:
${story.description}

ACCEPTANCE CRITERIA:
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

---
`;

  if (role === "test-writer") {
    return `${common}
YOUR TASK: Write ONLY test files for this story.
- Use the existing test framework (Bun test).
- Tests must fail because the feature is not implemented yet.
- Do NOT modify any existing source files.
- Do NOT implement the feature.
- Name tests consistently (e.g., test/*.test.ts).

IMPORTANT: Only write new test files or update existing ones. Do NOT touch src/*.`;
  }

  if (role === "implementer") {
    return `${common}
YOUR TASK: Implement the feature to make the tests pass.
- Read the tests in the current branch.
- Modify source files in src/ as needed.
- Do NOT modify test files unless there is a bug in the tests.
- Run tests frequently to check progress.
- Goal: All tests pass.`;
  }

  // Verifier
  return `${common}
YOUR TASK: Verify the implementation and tests.
- Ensure all tests pass.
- Check that the implementation meets all acceptance criteria.
- Fix any minor bugs or missing edge cases.
- Do NOT change the behavior unless it violates the criteria.
- Goal: High-quality implementation and passing tests.`;
}

/**
 * Prompt to build the verifier's verification instructions (Session 3)
 */
export function buildVerifierPrompt(story: UserStory): string {
  return `# Session 3: Verify — "${story.title}"

STORY:
${story.description}

ACCEPTANCE CRITERIA:
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

---

## TASKS

1. Run all tests and verify they pass.
2. Review the implementation for quality and correctness.
3. Check that the implementation meets all acceptance criteria.
4. Check if test files were modified by the implementer (make sure they are legitimate fixes, NOT just loosening assertions to mask bugs).
5. If any issues exist, fix them minimally — do NOT refactor.

---

## IMPORTANT — Write Verdict File

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

/**
 * Prompt for a test-writer session (single-session lite variant)
 */
export function buildTestWriterPrompt(story: UserStory, contextMarkdown?: string): string {
  const contextSection = contextMarkdown ? `\n\n---\n\n${contextMarkdown}` : "";
  return `# Test Writer — "${story.title}"

Your role: Write failing tests ONLY. Do NOT implement any source code.

STORY:
${story.description}

ACCEPTANCE CRITERIA:
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

RULES:
- Only create or modify files in the test/ directory.
- Tests must fail (feature not implemented yet).
- Use Bun test (describe/test/expect).
- Cover all acceptance criteria.${contextSection}`;
}

/**
 * Prompt for a test-writer lite session (no isolation enforcement)
 */
export function buildTestWriterLitePrompt(story: UserStory, contextMarkdown?: string): string {
  const contextSection = contextMarkdown ? `\n\n---\n\n${contextMarkdown}` : "";
  return `# Test Writer (Lite) — "${story.title}"

Your role: Write failing tests. You MAY read source files and MAY import from source files to ensure correct types/interfaces. You may create minimal stubs in src/ if needed to make imports work, but do NOT implement real logic.

STORY:
${story.description}

ACCEPTANCE CRITERIA:
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

RULES:
- Primarily CREATE test files in the test/ directory.
- Stub-only src/ files are allowed (empty exports, no logic).
- Tests must fail for the right reasons (feature not implemented).
- Use Bun test (describe/test/expect).${contextSection}`;
}

/**
 * Prompt for an implementer session
 */
export function buildImplementerPrompt(story: UserStory, contextMarkdown?: string): string {
  const contextSection = contextMarkdown ? `\n\n---\n\n${contextMarkdown}` : "";
  return `# Implementer — "${story.title}"

Your role: Make all failing tests pass.

STORY:
${story.description}

ACCEPTANCE CRITERIA:
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

RULES:
- Implement source code in src/ to make tests pass.
- Do NOT modify test files.
- Run tests frequently to track progress.
- Goal: all tests green.${contextSection}`;
}

/**
 * Prompt for an implementer lite session (combined test + implement)
 */
export function buildImplementerLitePrompt(story: UserStory, contextMarkdown?: string): string {
  const contextSection = contextMarkdown ? `\n\n---\n\n${contextMarkdown}` : "";
  return `# Implementer (Lite) — "${story.title}"

Your role: Write tests AND implement the feature in a single session.

STORY:
${story.description}

ACCEPTANCE CRITERIA:
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

RULES:
- Write tests first (test/ directory), then implement (src/ directory).
- All tests must pass by the end.
- Use Bun test (describe/test/expect).
- Goal: all tests green, all criteria met.${contextSection}`;
}
