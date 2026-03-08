/**
 * Conventions Section
 *
 * Includes bun test scoping warning and commit message instructions (non-overridable).
 */

export function buildConventionsSection(): string {
  return (
    "# Conventions\n\n" +
    "Follow existing code patterns and conventions. Write idiomatic, maintainable code.\n\n" +
    "When running tests, run ONLY test files related to your changes (e.g. `bun test ./test/specific.test.ts`). " +
    "NEVER run `bun test` without a file filter — full suite output will flood your context window and cause failures.\n\n" +
    "Commit your changes when done using conventional commit format (e.g. `feat:`, `fix:`, `test:`)."
  );
}
