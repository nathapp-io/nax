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
      return (
        "# Role: Implementer\n\n" +
        "Your task: make failing tests pass.\n\n" +
        "Instructions:\n" +
        "- Implement source code in src/ to make tests pass\n" +
        "- Do NOT modify test files\n" +
        "- Run tests frequently to track progress\n" +
        "- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'\n" +
        "- Goal: all tests green, all changes committed"
      );
    }

    // lite variant
    return (
      "# Role: Implementer (Lite)\n\n" +
      "Your task: Write tests AND implement the feature in a single session.\n\n" +
      "Instructions:\n" +
      "- Write tests first (test/ directory), then implement (src/ directory)\n" +
      "- All tests must pass by the end\n" +
      "- Use Bun test (describe/test/expect)\n" +
      "- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'\n" +
      "- Goal: all tests green, all criteria met, all changes committed"
    );
  }

  if (role === "test-writer") {
    return (
      "# Role: Test-Writer\n\n" +
      "Your task: Write comprehensive failing tests for the feature.\n\n" +
      "Instructions:\n" +
      "- Create test files in test/ directory that cover acceptance criteria\n" +
      "- Tests must fail initially (RED phase) — the feature is not yet implemented\n" +
      "- Use Bun test (describe/test/expect)\n" +
      "- Write clear test names that document expected behavior\n" +
      "- Focus on behavior, not implementation details\n" +
      "- Goal: comprehensive test suite ready for implementation"
    );
  }

  if (role === "verifier") {
    return (
      "# Role: Verifier\n\n" +
      "Your task: Review and verify the implementation against acceptance criteria.\n\n" +
      "Instructions:\n" +
      "- Review all test results — verify tests pass\n" +
      "- Check that implementation meets all acceptance criteria\n" +
      "- Inspect code quality, error handling, and edge cases\n" +
      "- Verify test modifications (if any) are legitimate fixes\n" +
      "- Write a detailed verdict with reasoning\n" +
      "- Goal: provide comprehensive verification and quality assurance"
    );
  }

  if (role === "single-session") {
    return (
      "# Role: Single-Session\n\n" +
      "Your task: Write tests AND implement the feature in a single focused session.\n\n" +
      "Instructions:\n" +
      "- Phase 1: Write comprehensive tests (test/ directory)\n" +
      "- Phase 2: Implement to make all tests pass (src/ directory)\n" +
      "- Use Bun test (describe/test/expect)\n" +
      "- Run tests frequently throughout implementation\n" +
      "- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'\n" +
      "- Goal: all tests passing, all changes committed, full story complete"
    );
  }

  // tdd-simple role — test-driven development in one session
  return (
    "# Role: TDD-Simple\n\n" +
    "Your task: Write failing tests FIRST, then implement to make them pass.\n\n" +
    "Instructions:\n" +
    "- RED phase: Write failing tests FIRST for the acceptance criteria\n" +
    "- RED phase: Run the tests to confirm they fail\n" +
    "- GREEN phase: Implement the minimum code to make tests pass\n" +
    "- REFACTOR phase: Refactor while keeping tests green\n" +
    "- When all tests are green, stage and commit ALL changed files with: git commit -m 'feat: <description>'\n" +
    "- Goal: all tests passing, feature complete, all changes committed"
  );
}
