/**
 * TDD Prompt Builders
 *
 * Exported prompt builders for three-session TDD workflow.
 * Used by both the orchestrator and the prompts CLI command.
 */

import type { UserStory } from "../prd";

/**
 * Build prompt for test-writer session.
 *
 * @param story - User story
 * @param contextMarkdown - Optional context markdown
 * @returns Test-writer prompt
 */
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
export function buildVerifierPrompt(story: UserStory): string {
  return `# Test-Driven Development — Session 3: Verify

You are in the third session of a three-session TDD workflow. Tests and implementation are complete.

**Story:** ${story.title}

**Your tasks:**
1. Run all tests and verify they pass
2. Review the implementation for quality and correctness
3. Check that the implementation meets all acceptance criteria
4. Check if test files were modified by the implementer. If yes, verify the changes are legitimate fixes (e.g. fixing incorrect expectations) and NOT just loosening assertions to mask bugs.
5. If any issues exist, fix them minimally

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**Auto-approval criteria:**
- All tests pass
- Implementation is clean and follows conventions
- All acceptance criteria met
- Any test modifications by implementer are legitimate fixes

If everything looks good, you can approve automatically. If legitimate fixes are needed (e.g., minor test adjustments for legitimate reasons), make them and document why.

When done, commit any fixes with message: "fix: verify and adjust ${story.title}"`;
}
