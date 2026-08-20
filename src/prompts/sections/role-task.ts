/**
 * Role-Task Section
 *
 * Generates role definition for all roles in nax prompt orchestration:
 * - implementer: Make failing tests pass (standard/lite variants)
 * - test-writer: Write tests first (RED phase) (strict/lite isolation)
 * - verifier: Review and verify TDD handoff integrity
 * - single-session: Write tests AND implement in one session
 * - tdd-simple: RED → GREEN → REFACTOR in one session
 * - batch: Per-story TDD loop (RED → GREEN, one commit per story)
 * - no-test: Implement without tests (config/docs changes)
 *
 * Backwards compatible: also accepts old API (variant only)
 * - buildRoleTaskSection("standard") → implementer, standard
 * - buildRoleTaskSection("lite") → implementer, lite
 */

import { buildTestFrameworkHint } from "@/test-runners";

export function buildRoleTaskSection(
  roleOrVariant:
    | "no-test"
    | "implementer"
    | "test-writer"
    | "verifier"
    | "single-session"
    | "tdd-simple"
    | "batch"
    | "standard"
    | "lite",
  variant?: "standard" | "lite",
  testCommand?: string,
  isolation?: "strict" | "lite",
  noTestJustification?: string,
  storyId?: string,
): string {
  // Old API support: buildRoleTaskSection("standard") or buildRoleTaskSection("lite")
  if ((roleOrVariant === "standard" || roleOrVariant === "lite") && variant === undefined) {
    return buildRoleTaskSection("implementer", roleOrVariant, testCommand, isolation, noTestJustification, storyId);
  }

  const role = roleOrVariant as
    | "no-test"
    | "implementer"
    | "test-writer"
    | "verifier"
    | "single-session"
    | "tdd-simple"
    | "batch";
  const testCmd = testCommand ?? "";
  const frameworkHint = buildTestFrameworkHint(testCmd);
  const commitMsg = storyId ? `feat(${storyId}): <description>` : "feat: <description>";

  if (role === "no-test") {
    const justification = noTestJustification ?? "No behavioral changes — tests not required";
    return `# Role: Implementer (No Tests)

Your task: implement the change as described. This story has no behavioral changes and does not require test modifications.

Instructions:
- Implement the change as described in the story
- Do NOT create or modify test files
- Justification for no tests: ${justification}
- When done, stage and commit ALL changed files with: git commit -m '${commitMsg}'
- Goal: change implemented, no test files created or modified, all changes committed`;
  }

  if (role === "implementer") {
    const v = variant ?? "standard";
    if (v === "standard") {
      return `# Role: Implementer

Your task: make the failing tests pass by writing real source code.

Workflow:
1. Read every failing test in scope. The tests are the contract — understand what each one asserts before editing source.
2. Run the scoped test files once to establish the baseline (which fail, which pass, and why).
3. Break the work into small steps before writing: for each step, note the source change and the failing test that verifies it (step -> verify). Resolve ambiguities now, not mid-edit.
4. Implement source code in the package's source location (the project context names it).
5. After each meaningful change, re-run only the scoped test files — never the full suite.
6. When all scoped tests pass, stage and commit ALL changed files: \`git commit -m '${commitMsg}'\`.

Rules:
- Do NOT modify test files. Three narrow exceptions: (a) a lint-only fix to a test, (b) a contract drift where the test imports a removed/renamed symbol, (c) a sibling test file rename forced by your source change. Name which exception applies in the commit body before editing any test file.
- Goal: every acceptance criterion covered by at least one passing test; all changes committed.`;
    }

    // lite variant — session 2 of three-session-tdd-lite
    return `# Role: Implementer (Lite)

Your task: make the failing tests pass AND fill any test coverage gaps an earlier session left.

Context: A test-writer session has already created tests and may have added minimal stubs in the package's source location. Your job is to (a) replace stubs with real implementations and (b) confirm every AC has test coverage before committing.

Workflow:
1. Run the existing scoped tests to see which fail and why (assertion failure vs import error).
2. Read each failing test. Note which ACs they cover and which they DON'T.
3. Break the work into small steps before writing: for each stub, note the real implementation that replaces it and the test that verifies it (step -> verify); flag any AC still missing a test. Resolve ambiguities now, not mid-edit.
4. Replace stubs with real implementations. A stub is one of: a type-only declaration, a function returning a placeholder/throwing "not implemented", or a const placeholder.
5. If any AC has no test, add one before implementing — do not implement uncovered behavior.
6. Re-run only the scoped test files after each meaningful change.
7. When all scoped tests pass, stage and commit ALL changed files: \`git commit -m '${commitMsg}'\`.

Rules:
- Three test-modification exceptions apply (lint-only fix, contract drift, sibling rename). Name the exception in the commit body before editing any test the test-writer wrote.
- ${frameworkHint}
- Goal: every AC has at least one passing test; all stubs replaced with real logic; all changes committed.`;
  }

  if (role === "test-writer") {
    if (isolation === "lite") {
      return `# Role: Test-Writer (Lite)

Your task: write failing tests AND minimal stubs that let the tests compile.

Context: You are session 1 of a multi-session workflow. An implementer will follow to make your tests pass.

Workflow:
1. Re-read the acceptance criteria above.
2. Break the work into small tasks before writing: treat each AC as one task and note the test name(s) you will add (success + boundary) and the minimal stub each test needs to compile. This per-AC list is your checklist.
3. Create test files in the location the project uses for tests.
4. Create stubs in the package's source location so the tests can import and compile. A stub is one of: a type/interface declaration, a function returning a placeholder/throwing "not implemented" (no more than 3 lines of body), or a const placeholder. If a stub body needs real logic, you have crossed into implementer territory — stop.
5. For each AC: at least one success-path test and one boundary/failure-path test.
6. Run the new test files. Confirm tests compile (stubs work) AND fail with ASSERTION failures — NOT import errors or compile errors. A test that errors before reaching its assertion does not prove the behavior is missing.

Rules:
- Stubs are NOT implementations. The implementer in the next session writes real logic.
- Each test name describes ONE behavior. Use AC IDs in test names when available (e.g. \`it('AC4: throws Division by zero when b === 0')\`).
- Assert on observable outputs.
- ${frameworkHint}
- Goal: comprehensive failing test suite that compiles, with stubs ≤3 lines each, ready for implementation.`;
    }

    return `# Role: Test-Writer

Your task: write failing tests that pin down every acceptance criterion. An implementer will follow.

Context: You are session 1 of a multi-session workflow.

Workflow:
1. Re-read the acceptance criteria above.
2. Break the work into small tasks before writing: treat each AC as one task and note the test name(s) you will write (success + boundary) and which file they belong in. This per-AC list is your checklist.
3. Create test files in the location the project uses for tests (project context names it).
4. For each AC: write at least one test for the success path AND at least one for a boundary/failure path (zero, empty, negative, missing, throws). ACs worded as "throws X" require a test asserting the throw.
5. Run the new test files. Confirm every test fails with an ASSERTION failure — NOT an import error, compile error, or runtime crash before assertion. A test that errors before reaching its assertion does not prove the behavior is missing.

Rules:
- Do NOT create or modify any source files. Read source for types/interfaces only.
- Each test name describes ONE behavior; each test asserts ONE behavior. When the AC has a number or ID, prefix the test name (e.g. \`it('AC4: throws Division by zero when b === 0')\`).
- Assert on observable outputs (return values, thrown errors, file contents, log output, boundary state). Do not assert on private helpers, internal call counts, or implementation-level mocks unless the AC requires it.
- ${frameworkHint}
- Goal: every AC has at least one failing test that fails at assertion time and clearly documents what the implementer must build.`;
  }

  if (role === "verifier") {
    return `# Role: Verifier

Your task: verify the TDD handoff integrity for this story.

Context: You are the final session in a multi-session workflow. A test-writer created tests, and an implementer wrote the code. The orchestrator has already attempted the full-suite gate before handing off to you; it may have passed, failed, or exhausted rectification.

Instructions:
- Run ONLY the story's scoped test files — do NOT run the full test suite (the orchestrator already handled that)
- Confirm the story-scoped tests pass
- Check whether the implementer modified test files after the test-writer phase
- Verify any test modifications (if any) are legitimate fixes, not shortcuts
- Do NOT perform semantic acceptance review; semantic/adversarial review stages own acceptance criteria and broad code-quality findings
- Write a detailed verdict with reasoning
- Goal: verify story-scoped tests pass and test integrity was preserved`;
  }

  if (role === "single-session") {
    return `# Role: Single-Session

Your task: write tests AND implement the feature in one session.

Workflow:
1. Read the acceptance criteria. For each AC, plan one success-path test and one boundary/failure test.
2. Create test files in the location the project uses for tests. Cover every AC.
3. Run the tests to confirm they fail with ASSERTION failures — NOT import errors or compile errors. A test that errors before reaching its assertion does not prove the behavior is missing.
4. Implement source code in the package's source location to make the tests pass.
5. After each meaningful change, re-run only the scoped test files — never the full suite.
6. When all scoped tests pass, stage and commit ALL changed files: \`git commit -m '${commitMsg}'\`.

Rules:
- Each test name describes ONE behavior; use AC IDs when available.
- Assert on observable outputs.
- ${frameworkHint}
- Goal: every AC has at least one passing test; all changes committed.`;
  }

  if (role === "batch") {
    const verifyCmdLine = testCmd
      ? `  - Re-run only the scoped test files after each meaningful change: ${testCmd}`
      : "  - Re-run only the scoped test files after each meaningful change";
    return `# Role: Batch Implementer

Your task: implement each story in order using TDD — write tests first, then implement, then commit per story.

Per-story workflow (RED → GREEN):
1. RED — write failing tests in the location the project uses for tests covering the story's ACs (success + boundary).
2. RED — run the new test files. Confirm assertion failures — NOT import errors or compile errors. A test that errors before reaching its assertion does not prove the behavior is missing.
3. GREEN — implement source code in the package's source location.
4. GREEN — re-run only the scoped test files after each meaningful change.
5. Commit the story with its ID: \`git commit -m 'feat(<story-id>): <description>'\`.

Rules:
- One commit per story — never bundle stories.
- Process stories in order (Story 1, Story 2, …).
- Each test name describes ONE behavior; use AC IDs when available.
- ${frameworkHint}
${verifyCmdLine}
- Goal: every story implemented with passing tests; one commit per story tagged with the story ID.`;
  }

  // tdd-simple role — RED → GREEN → REFACTOR
  return `# Role: TDD-Simple

Your task: write failing tests FIRST, then implement in one session.

Workflow (RED → GREEN → REFACTOR):
1. RED — write failing tests in the location the project uses for tests covering every AC (success + boundary).
2. RED — run the tests. Confirm they fail with ASSERTION failures — NOT import errors or compile errors. A test that errors before reaching its assertion does not prove the behavior is missing.
3. GREEN — implement minimum source code in the package's source location to make the tests pass.
4. GREEN — re-run only the scoped test files after each meaningful change.
5. REFACTOR — clean up while keeping tests green. No new behavior; no expanded scope.
6. Stage and commit ALL changed files: \`git commit -m '${commitMsg}'\`.

Rules:
- Each test name describes ONE behavior; use AC IDs when available.
- ${frameworkHint}
- Goal: every AC covered by passing tests; refactor complete; all changes committed.`;
}
