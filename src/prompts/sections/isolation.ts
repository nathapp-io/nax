/**
 * Isolation Rules Section
 *
 * Generates isolation rules based on mode:
 * - strict: No access to src/ files
 * - lite: May read src/ and create minimal stubs
 */

const TEST_FILTER_RULE =
  "When running tests, run ONLY test files related to your changes " +
  "(e.g. `bun test ./test/specific.test.ts`). NEVER run `bun test` without a file filter " +
  "— full suite output will flood your context window and cause failures.";

export function buildIsolationSection(mode: "strict" | "lite"): string {
  const header = "# Isolation Rules\n\n";
  const footer = `\n\n${TEST_FILTER_RULE}`;

  if (mode === "strict") {
    return `${header}isolation scope: Isolation scope: Only create or modify files in the test/ directory. Tests must fail because the feature is not yet implemented. Do NOT modify any source files in src/.${footer}`;
  }

  // lite mode
  return `${header}isolation scope: Create test files in test/. MAY read src/ files and MAY import from src/ to ensure correct types/interfaces. May create minimal stubs in src/ if needed to make imports work, but do NOT implement real logic.${footer}`;
}
