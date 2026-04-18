/**
 * Role-Task Section
 *
 * Generates role definition for all 5 roles in nax prompt orchestration:
 * - implementer: Make failing tests pass (standard/lite variants)
 * - test-writer: Write tests first (RED phase)
 * - verifier: Review and verify implementation
 * - single-session: Write tests AND implement in one session
 * - tdd-simple: Write failing tests FIRST, then implement in one session
 *
 * Backwards compatible: also accepts old API (variant only)
 * - buildRoleTaskSection("standard") → implementer, standard
 * - buildRoleTaskSection("lite") → implementer, lite
 */

import { buildTestFrameworkHint } from "../../test-runners";

export function buildRoleTaskSection(
  roleOrVariant:
    | "no-test"
    | "implementer"
    | "test-writer"
    | "verifier"
    | "single-session"
    | "tdd-simple"
    | "batch"
    | "standard"
    | "lite",
  variant?: "standard" | "lite",
  testCommand?: string,
  isolation?: "strict" | "lite",
  noTestJustification?: string,
): string {
  // Old API support: buildRoleTaskSection("standard") or buildRoleTaskSection("lite")
  if ((roleOrVariant === "standard" || roleOrVariant === "lite") && variant === undefined) {
    return buildRoleTaskSection("implementer", roleOrVariant, testCommand, isolation);
  }

  const role = roleOrVariant as
    | "no-test"
    | "implementer"
    | "test-writer"
    | "verifier"
    | "single-session"
    | "tdd-simple"
    | "batch";
  const testCmd = testCommand ?? "";
  const frameworkHint = buildTestFrameworkHint(testCmd);

  if (role === "no-test") {
    const justification = noTestJustification ?? "No behavioral changes — tests not required";
    return `# Role: Implementer (No Tests)

Your task: implement the change as described. This story has no behavioral changes and does not require test modifications.

Instructions:
- Implement the change as described in the story
- Do NOT create or modify test files
- Justification for no tests: ${justification}
- When done, stage and commit ALL changed files with: git commit -m 'feat: <description>'
- Goal: change implemented, no test files created or modified, all changes committed`;
  }

  if (role === "implementer") {
    const v = variant ?? "standard";
    if (v === "standard") {
      return `# Role: Implementer

Your task: make failing tests pass.

Instructions:
- Implement source code in src/ to make tests pass
- Do NOT modify test files
- Run tests frequently to track progress
- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'
- Goal: all tests green, all changes committed`;
    }

    // lite variant — session 2 of three-session-tdd-lite
    return `# Role: Implementer (Lite)

Your task: Make the failing tests pass AND add any missing test coverage.

Context: A test-writer session has already created test files with failing tests and possibly minimal stubs in src/. Your job is to make those tests pass by implementing the real logic.

Instructions:
- Start by running the existing tests to see what's failing
- Implement source code in src/ to make all failing tests pass
- You MAY add additional tests if you find gaps in coverage
- Replace any stubs with real implementations
- ${frameworkHint}
- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'
- Goal: all tests green, all criteria met, all changes committed`;
  }

  if (role === "test-writer") {
    if (isolation === "lite") {
      return `# Role: Test-Writer (Lite)

Your task: Write failing tests for the feature. You may create minimal stubs to support imports.

Context: You are session 1 of a multi-session workflow. An implementer will follow to make your tests pass.

Instructions:
- Create test files in test/ directory that cover all acceptance criteria
- Tests must fail initially (RED phase) — do NOT implement real logic
- ${frameworkHint}
- You MAY read src/ files and import types/interfaces from them
- You MAY create minimal stubs in src/ (type definitions, empty functions) so tests can import and compile
- Write clear test names that document expected behavior
- Focus on behavior, not implementation details
- Goal: comprehensive failing test suite with compilable imports, ready for implementation`;
    }

    return `# Role: Test-Writer

Your task: Write comprehensive failing tests for the feature.

Context: You are session 1 of a multi-session workflow. An implementer will follow to make your tests pass.

Instructions:
- Create test files in test/ directory that cover all acceptance criteria
- Tests must fail initially (RED phase) — the feature is not yet implemented
- Do NOT create or modify any files in src/
- ${frameworkHint}
- Write clear test names that document expected behavior
- Focus on behavior, not implementation details
- Goal: comprehensive failing test suite ready for implementation`;
  }

  if (role === "verifier") {
    return `# Role: Verifier

Your task: Review and verify the implementation against acceptance criteria.

Context: You are the final session in a multi-session workflow. A test-writer created tests, and an implementer wrote the code. The orchestrator has already run the full test suite and confirmed it passes before handing off to you.

Instructions:
- Run ONLY the story's scoped test files — do NOT run the full test suite (the orchestrator already handled that)
- Check that implementation meets all acceptance criteria from the story
- Inspect code quality, error handling, and edge cases
- Verify any test modifications (if any) are legitimate fixes, not shortcuts
- Write a detailed verdict with reasoning
- Goal: verify story-scoped tests pass, provide comprehensive code review and quality assurance`;
  }

  if (role === "single-session") {
    return `# Role: Single-Session

Your task: Write tests AND implement the feature in a single focused session.

Instructions:
- Phase 1: Write comprehensive tests (test/ directory)
- Phase 2: Implement to make all tests pass (src/ directory)
- ${frameworkHint}
- Run tests frequently throughout implementation
- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'
- Goal: all tests passing, all changes committed, full story complete`;
  }

  if (role === "batch") {
    const verifyCmdLine = testCmd
      ? `  - Verify all tests pass: ${testCmd}`
      : "  - Verify all tests pass using your project's test command";
    return `# Role: Batch Implementer

Your task: Implement each story in order using TDD — write tests first, then implement, then verify.

Instructions:
- Process each story in order (Story 1, Story 2, …)
- For each story:
  - Write failing tests FIRST covering the acceptance criteria
  - Run tests to confirm they fail (RED phase)
  - Implement the minimum code to make tests pass (GREEN phase)
${verifyCmdLine}
  - Commit the story with its story ID in the commit message: git commit -m 'feat(<story-id>): <description>'
- ${frameworkHint}
- Do NOT commit multiple stories together — each story gets its own commit
- Goal: all stories implemented, all tests passing, each story committed with its story ID`;
  }

  // tdd-simple role — test-driven development in one session
  return `# Role: TDD-Simple

Your task: Write failing tests FIRST, then implement to make them pass.

Instructions:
- RED phase: Write failing tests FIRST for the acceptance criteria
- RED phase: Run the tests to confirm they fail
- GREEN phase: Implement the minimum code to make tests pass
- REFACTOR phase: Refactor while keeping tests green
- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'
- Goal: all tests passing, feature complete, all changes committed`;
}
