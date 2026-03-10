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

export function buildRoleTaskSection(
  roleOrVariant: "implementer" | "test-writer" | "verifier" | "single-session" | "tdd-simple" | "standard" | "lite",
  variant?: "standard" | "lite",
): string {
  // Old API support: buildRoleTaskSection("standard") or buildRoleTaskSection("lite")
  if ((roleOrVariant === "standard" || roleOrVariant === "lite") && variant === undefined) {
    return buildRoleTaskSection("implementer", roleOrVariant);
  }

  const role = roleOrVariant as "implementer" | "test-writer" | "verifier" | "single-session" | "tdd-simple";

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

    // lite variant
    return `# Role: Implementer (Lite)

Your task: Write tests AND implement the feature in a single session.

Instructions:
- Write tests first (test/ directory), then implement (src/ directory)
- All tests must pass by the end
- Use Bun test (describe/test/expect)
- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'
- Goal: all tests green, all criteria met, all changes committed`;
  }

  if (role === "test-writer") {
    return `# Role: Test-Writer

Your task: Write comprehensive failing tests for the feature.

Instructions:
- Create test files in test/ directory that cover acceptance criteria
- Tests must fail initially (RED phase) — the feature is not yet implemented
- Use Bun test (describe/test/expect)
- Write clear test names that document expected behavior
- Focus on behavior, not implementation details
- Goal: comprehensive test suite ready for implementation`;
  }

  if (role === "verifier") {
    return `# Role: Verifier

Your task: Review and verify the implementation against acceptance criteria.

Instructions:
- Review all test results — verify tests pass
- Check that implementation meets all acceptance criteria
- Inspect code quality, error handling, and edge cases
- Verify test modifications (if any) are legitimate fixes
- Write a detailed verdict with reasoning
- Goal: provide comprehensive verification and quality assurance`;
  }

  if (role === "single-session") {
    return `# Role: Single-Session

Your task: Write tests AND implement the feature in a single focused session.

Instructions:
- Phase 1: Write comprehensive tests (test/ directory)
- Phase 2: Implement to make all tests pass (src/ directory)
- Use Bun test (describe/test/expect)
- Run tests frequently throughout implementation
- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'
- Goal: all tests passing, all changes committed, full story complete`;
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
