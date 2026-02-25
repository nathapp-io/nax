import type { Story, RunConfig } from "../execution/types";
import type { TddSessionRole } from "./types";

/**
 * Prompt to build the TDD agent's role definition
 */
export function buildTddRolePrompt(
  role: TddSessionRole,
  story: Story,
  config: RunConfig,
  currentBranch: string,
): string {
  const common = `You are a TDD agent (role: ${role}) working on the story: "${story.title}".
Project root: ${config.projectRoot}
Current branch: ${currentBranch}

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
 * Prompt to build the verifier's verification instructions
 */
export function buildVerifierPrompt(story: Story, config: RunConfig, currentBranch: string): string {
  return `Verify the implementation of story: "${story.title}" on branch: ${currentBranch}.

Project root: ${config.projectRoot}

STORY:
${story.description}

CRITERIA:
${story.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}

TASKS:
1. Run all tests and ensure they pass.
2. Review the implementation in src/ for correctness and quality.
3. Check for any illegitimate test modifications by the implementer (e.g., deleted tests).
4. Fix any minor issues or missing edge cases.
5. If everything looks good, approve the implementation.

Set \`approved: true\` if:
- All tests pass
- Implementation is clean and follows conventions
- All acceptance criteria met
- Any test modifications by implementer are legitimate fixes

If everything looks good, you can approve automatically. If legitimate fixes are needed (e.g., minor test adjustments for legitimate reasons), make them and document why.

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

export function buildTestWriterPrompt(story: UserStory, contextMarkdown?: string): string {
  const basePrompt = `# Test-Driven Development — Session 1: Write Tests

You are in the first session of a three-session TDD workflow. Your ONLY job is to write comprehensive tests.

**Story:** ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**CRITICAL RULES:**
- ONLY create/modify test files (test/, tests/, __tests__/, *.test.ts, *.spec.ts)
- DO NOT create or modify any source files (src/, lib/, etc.)
- Write failing tests that verify all acceptance criteria
- Use descriptive test names and organize into logical test suites
- Follow TDD best practices: one assertion per test where reasonable
- Tests should be clear, comprehensive, and cover edge cases

The implementer in the next session will make these tests pass. Your job is ONLY to write the tests.

When done, commit your changes with message: "test: add tests for ${story.title}"`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/**
 * Build prompt for implementer session.
 *
 * @param story - User story
 * @param contextMarkdown - Optional context markdown
 * @returns Implementer prompt
 */

export function buildImplementerPrompt(story: UserStory, contextMarkdown?: string): string {
  const basePrompt = `# Test-Driven Development — Session 2: Implement Code

You are in the second session of a three-session TDD workflow. Tests have already been written in session 1.

**Story:** ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**CRITICAL RULES:**
- DO NOT modify any test files — tests are already written and correct
- ONLY create/modify source files (src/, lib/, etc.) to make the tests pass
- Run the tests frequently to verify your implementation
- Write minimal code to make tests pass (no over-engineering)
- Follow existing code patterns and conventions in the codebase
- Ensure all tests pass before finishing

The tests were written in session 1. Your job is to implement the code to make them pass.

When done, commit your changes with message: "feat: implement ${story.title}"`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/**
 * Build prompt for test-writer session in lite mode.
 *
 * Relaxed isolation: test-writer CAN read source files to understand existing
 * APIs and CAN import from source. Still should only CREATE test files, not
 * modify source files.
 *
 * @param story - User story
 * @param contextMarkdown - Optional context markdown
 * @returns Test-writer lite prompt
 */

export function buildTestWriterLitePrompt(story: UserStory, contextMarkdown?: string): string {
  const basePrompt = `# Test-Driven Development (Lite Mode) — Session 1: Write Tests

You are in the first session of a three-session TDD workflow (lite mode). Your ONLY job is to write comprehensive tests.

**Story:** ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**RULES:**
- You MAY read source files to understand existing APIs and import paths
- You MAY import from source files in your tests
- Only CREATE test files (test/, tests/, __tests__/, *.test.ts, *.spec.ts) — do NOT modify source files
- Write failing tests that verify all acceptance criteria
- Use descriptive test names and organize into logical test suites
- Follow TDD best practices: one assertion per test where reasonable
- Tests should be clear, comprehensive, and cover edge cases

The implementer in the next session will make these tests pass. Your job is ONLY to write the tests.

When done, commit your changes with message: "test: add tests for ${story.title}"`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/**
 * Build prompt for implementer session in lite mode.
 *
 * No file isolation restrictions: implementer can freely modify both source
 * and test files as needed to make tests pass.
 *
 * @param story - User story
 * @param contextMarkdown - Optional context markdown
 * @returns Implementer lite prompt
 */

export function buildImplementerLitePrompt(story: UserStory, contextMarkdown?: string): string {
  const basePrompt = `# Test-Driven Development (Lite Mode) — Session 2: Implement Code

You are in the second session of a three-session TDD workflow (lite mode). Tests have already been written in session 1.

**Story:** ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**RULES:**
- Run the tests frequently to verify your implementation
- Write code to make all tests pass
- You may adjust test files if needed (e.g., fixing incorrect expectations or import paths)
- Write clean, maintainable code following existing patterns and conventions
- Ensure all tests pass before finishing

The tests were written in session 1. Your job is to implement the code to make them pass.

When done, commit your changes with message: "feat: implement ${story.title}"`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/**
 * Build prompt for verifier session.
 *
 * @param story - User story
 * @returns Verifier prompt
 */
