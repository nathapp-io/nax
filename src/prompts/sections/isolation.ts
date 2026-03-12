/**
 * Isolation Rules Section
 *
 * Generates isolation rules for all 5 roles:
 * - test-writer: Strict/Lite modes for test-first TDD
 * - implementer: Implement source while respecting test integrity
 * - verifier: Read-only inspection
 * - single-session: Both test/ and src/ modification allowed
 * - tdd-simple: Both test/ and src/ modification allowed (no isolation)
 *
 * Backwards compatible: also accepts old API (mode only)
 * - buildIsolationSection("strict") → test-writer, strict
 * - buildIsolationSection("lite") → test-writer, lite
 */

const DEFAULT_TEST_CMD = "bun test";

function buildTestFilterRule(testCommand: string): string {
  return `When running tests, run ONLY test files related to your changes (e.g. \`${testCommand} <path/to/test-file>\`). NEVER run the full test suite without a filter — full suite output will flood your context window and cause failures.`;
}

export function buildIsolationSection(
  roleOrMode:
    | "implementer"
    | "test-writer"
    | "verifier"
    | "single-session"
    | "tdd-simple"
    | "batch"
    | "strict"
    | "lite",
  mode?: "strict" | "lite",
  testCommand?: string,
): string {
  // Old API support: buildIsolationSection("strict") or buildIsolationSection("lite")
  if ((roleOrMode === "strict" || roleOrMode === "lite") && mode === undefined) {
    return buildIsolationSection("test-writer", roleOrMode, testCommand);
  }

  const role = roleOrMode as "implementer" | "test-writer" | "verifier" | "single-session" | "tdd-simple" | "batch";
  const testCmd = testCommand ?? DEFAULT_TEST_CMD;

  const header = "# Isolation Rules";
  const footer = `\n\n${buildTestFilterRule(testCmd)}`;

  if (role === "test-writer") {
    const m = mode ?? "strict";
    if (m === "strict") {
      return `${header}\n\nisolation scope: Only create or modify files in the test/ directory. Tests must fail because the feature is not yet implemented. Do NOT modify any source files in src/.${footer}`;
    }

    // lite mode for test-writer
    return `${header}\n\nisolation scope: Create test files in test/. MAY read src/ files and MAY import from src/ to ensure correct types/interfaces. May create minimal stubs in src/ if needed to make imports work, but do NOT implement real logic.${footer}`;
  }

  if (role === "implementer") {
    return `${header}\n\nisolation scope: Implement source code in src/ to make tests pass. Do not modify test files. Run tests frequently to track progress.${footer}`;
  }

  if (role === "verifier") {
    return `${header}\n\nisolation scope: Read-only inspection. Review all test results, implementation code, and acceptance criteria compliance. You MAY write a verdict file (.nax-verifier-verdict.json) and apply legitimate fixes if needed.${footer}`;
  }

  if (role === "single-session") {
    return `${header}\n\nisolation scope: Create test files in test/ directory, then implement source code in src/ to make tests pass. Both directories are in scope for this session.${footer}`;
  }

  // tdd-simple role — no isolation restrictions but still needs the test filter rule
  return `${header}\n\nisolation scope: You may modify both src/ and test/ files. Write failing tests FIRST, then implement to make them pass.${footer}`;
}
