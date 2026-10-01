/**
 * TDD Language Convention Section
 *
 * Returns a language-specific test file naming and placement convention block
 * for injection into TDD test-writer prompts.
 *
 * Returns empty string for TypeScript/undefined (existing behavior preserved).
 */

/**
 * Builds the TDD language convention section for the prompt.
 *
 * @param language - The project language (e.g. 'go', 'rust', 'python')
 * @returns Language-specific convention block, or empty string for TypeScript/undefined.
 */
export function buildTddLanguageSection(language: string | undefined): string {
  switch (language) {
    case "go":
      return "# TDD File Conventions\n\nTest files are named `<filename>_test.go` and placed in the same package directory as the source file.";
    case "rust":
      return "# TDD File Conventions\n\nTests go in an inline `#[cfg(test)]` module at the bottom of the source file, or in `tests/<filename>.rs` for integration tests.";
    case "python":
      return "# TDD File Conventions\n\nTest files are named `test_<source_filename>.py` under the `tests/` directory.";
    default:
      return "";
  }
}
