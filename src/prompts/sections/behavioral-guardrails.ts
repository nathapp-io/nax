export type GuardrailLevel = "off" | "lite" | "strict";

export type GuardrailRole =
  | "no-test"
  | "implementer"
  | "test-writer"
  | "verifier"
  | "single-session"
  | "tdd-simple"
  | "batch";

export function buildBehavioralGuardrailsSection(
  role: GuardrailRole,
  level: GuardrailLevel,
  // Reserved for Phase 2: per-variant and per-isolation rule differentiation.
  // Currently unused — all variants/isolation modes produce identical output per role.
  _variant?: "standard" | "lite",
  _isolation?: "strict" | "lite",
): string | null {
  if (level === "off" || role === "verifier" || role === "no-test") {
    return null;
  }

  if (role === "test-writer") {
    return buildTestWriterGuardrails(level);
  }

  return buildImplementerGuardrails(level);
}

function buildTestWriterGuardrails(level: GuardrailLevel): string {
  const lines = [
    "# Behavioral Guardrails",
    "",
    "- Simplicity: write tests that cover the acceptance criteria. No tests for behaviors the story does not require.",
    "- Surgical: do not modify source files beyond the stub allowance in the Isolation Rules above. Do not add tests for unrelated existing code.",
  ];
  if (level === "strict") {
    lines.push(
      "- State Assumptions: when the story is ambiguous, pick an interpretation, proceed, and document the choice in the commit body under `Assumptions:`. Do not invent requirements; do not silently choose when the story is genuinely under-specified — note it.",
    );
  }
  return lines.join("\n");
}

function buildImplementerGuardrails(level: GuardrailLevel): string {
  if (level === "lite") {
    return `# Behavioral Guardrails

- Simplicity: write the minimum code that makes the tests pass. No speculative abstractions, configurability, or error handling for scenarios that cannot occur.
- Surgical: every changed line must trace to the story. Do not refactor adjacent code, reformat unrelated files, or rename symbols beyond what the story requires.
- Anti-cheat: do not weaken assertions, catch-and-swallow exceptions in tests, or add tautological assertions to coerce a green run.
- Orphans: remove imports/variables/helpers that YOUR changes made unused. Do not delete pre-existing dead code.
- Commit: include the story ID when known — \`feat(<story-id>): <description>\`.`;
  }

  return `# Behavioral Guardrails

## Simplicity
Write the minimum code that makes the tests pass. Every line you add is a line someone else must read, understand, and maintain. Do not add speculative abstractions, configurability, or error handling for scenarios that cannot occur given the story's constraints. If it isn't required by a test or acceptance criterion, don't write it.

## Surgical
Every changed line must trace directly to a story requirement or a failing test. Do not refactor adjacent code, reformat unrelated files, or rename symbols beyond what the story requires. Reviewers will flag any change that cannot be linked to a specific requirement.

## Anti-cheat
Do not weaken assertions, catch-and-swallow exceptions in tests, or add tautological assertions to coerce a green run. A green test suite achieved by weakening tests is not a passing implementation — it is a failing one with hidden evidence.

## Orphans
Remove imports, variables, and helpers that YOUR changes made unused. Do not delete pre-existing dead code that was already there before your changes.

## Commit
Include the story ID when known — \`feat(<story-id>): <description>\`.

## State Assumptions
When the story is ambiguous, pick an interpretation, proceed, and document the choice in the commit body under \`Assumptions:\`. Do not invent requirements; do not silently choose when the story is genuinely under-specified — note it.`;
}
