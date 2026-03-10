/**
 * Conventions Section
 *
 * Includes bun test scoping warning and commit message instructions (non-overridable).
 */

export function buildConventionsSection(): string {
  return `# Conventions

Follow existing code patterns and conventions. Write idiomatic, maintainable code.

Commit your changes when done using conventional commit format (e.g. \`feat:\`, \`fix:\`, \`test:\`).`;
}
