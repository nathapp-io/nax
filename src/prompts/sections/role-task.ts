/**
 * Role-Task Section
 *
 * Generates role definition for:
 * - standard: Make failing tests pass (implementer role)
 * - lite: Write tests first then implement (combined role)
 */

export function buildRoleTaskSection(variant: "standard" | "lite"): string {
  if (variant === "standard") {
    return (
      "# Role: Implementer\n\n" +
      "Your task: make failing tests pass.\n\n" +
      "Instructions:\n" +
      "- Implement source code in src/ to make tests pass\n" +
      "- Do NOT modify test files\n" +
      "- Run tests frequently to track progress\n" +
      "- When all tests are green, stage and commit ALL changed files with git commit -m 'feat: <description>'\n" +
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
    "- When all tests are green, stage and commit ALL changed files with git commit -m 'feat: <description>'\n" +
    "- Goal: all tests green, all criteria met, all changes committed"
  );
}
