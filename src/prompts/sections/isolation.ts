/**
 * Isolation Rules Section
 *
 * Generates isolation rules for all 4 roles:
 * - test-writer: Strict/Lite modes for test-first TDD
 * - implementer: Implement source while respecting test integrity
 * - verifier: Read-only inspection
 * - single-session: Both test/ and src/ modification allowed
 *
 * Backwards compatible: also accepts old API (mode only)
 * - buildIsolationSection("strict") → test-writer, strict
 * - buildIsolationSection("lite") → test-writer, lite
 */

const TEST_FILTER_RULE =
  "When running tests, run ONLY test files related to your changes " +
  "(e.g. `bun test ./test/specific.test.ts`). NEVER run `bun test` without a file filter " +
  "— full suite output will flood your context window and cause failures.";

export function buildIsolationSection(
  roleOrMode: "implementer" | "test-writer" | "verifier" | "single-session" | "strict" | "lite",
  mode?: "strict" | "lite",
): string {
  // Old API support: buildIsolationSection("strict") or buildIsolationSection("lite")
  if ((roleOrMode === "strict" || roleOrMode === "lite") && mode === undefined) {
    return buildIsolationSection("test-writer", roleOrMode);
  }

  const role = roleOrMode as "implementer" | "test-writer" | "verifier" | "single-session";

  const header = "# Isolation Rules\n\n";
  const footer = `\n\n${TEST_FILTER_RULE}`;

  if (role === "test-writer") {
    const m = mode ?? "strict";
    if (m === "strict") {
      return `${header}isolation scope: Only create or modify files in the test/ directory. Tests must fail because the feature is not yet implemented. Do NOT modify any source files in src/.${footer}`;
    }

    // lite mode for test-writer
    return `${header}isolation scope: Create test files in test/. MAY read src/ files and MAY import from src/ to ensure correct types/interfaces. May create minimal stubs in src/ if needed to make imports work, but do NOT implement real logic.${footer}`;
  }

  if (role === "implementer") {
    return `${header}isolation scope: Implement source code in src/ to make tests pass. Do not modify test files. Run tests frequently to track progress.${footer}`;
  }

  if (role === "verifier") {
    return `${header}isolation scope: Read-only inspection. Review all test results, implementation code, and acceptance criteria compliance. You MAY write a verdict file (.nax-verifier-verdict.json) and apply legitimate fixes if needed.${footer}`;
  }

  // single-session role
  return `${header}isolation scope: Create test files in test/ directory, then implement source code in src/ to make tests pass. Both directories are in scope for this session.${footer}`;
}
