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
 *
 * US-004 — when a configured test command AND a declared scoped key are
 * both supplied, the test-filter rule's shell example is wrapped in a
 * `test-scope` protocol region. Dispatch substitutes a `RunCommand` tool
 * call under native + `RunCommand`; otherwise the ACP body (the shell
 * example and the surrounding full-suite warning sentence) is preserved
 * verbatim. The shell example is omitted entirely (no region) when no
 * test command is configured — the `#543` fallback (`scope each run to the
 * files you changed`) is what ships under that branch.
 */

import { wrapAffordance } from "./protocol-region";

function buildTestFilterRule(testCommand: string, scopedCommandName?: string): string {
  // #543: do not invent a `bun test` example for Go / Python / Rust packages.
  if (!testCommand) {
    return `When running tests, run ONLY test files related to your changes (scope each run to the files you changed). NEVER run the full test suite without a filter — full suite output will flood your context window and cause failures.`;
  }
  const sentence = `When running tests, run ONLY test files related to your changes (e.g. \`${testCommand} <path/to/test-file>\`). NEVER run the full test suite without a filter — full suite output will flood your context window and cause failures.`;
  // Only wrap when a declared scoped key is supplied — the wrapping produces
  // a `RunCommand {"command": "<scopedKey>", "values": {"files": ""}}` call
  // and that tool call requires a key the project actually declared.
  if (!scopedCommandName) return sentence;
  return wrapAffordance("test-scope", { command: scopedCommandName, files: "" }, sentence);
}

export function buildIsolationSection(
  roleOrMode:
    | "no-test"
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
  scopedCommandName?: string,
): string {
  // Old API support: buildIsolationSection("strict") or buildIsolationSection("lite")
  if ((roleOrMode === "strict" || roleOrMode === "lite") && mode === undefined) {
    return buildIsolationSection("test-writer", roleOrMode, testCommand, scopedCommandName);
  }

  const role = roleOrMode as
    | "no-test"
    | "implementer"
    | "test-writer"
    | "verifier"
    | "single-session"
    | "tdd-simple"
    | "batch";
  const testCmd = testCommand ?? "";

  const header = "# Isolation Rules";
  const footer = `\n\n${buildTestFilterRule(testCmd, scopedCommandName)}`;

  if (role === "no-test") {
    return "";
  }

  if (role === "test-writer") {
    const m = mode ?? "strict";
    if (m === "strict") {
      return `${header}\n\nisolation scope: Only create or modify files in the test/ directory. Tests must fail because the feature is not yet implemented. Do NOT modify any source files in src/.${footer}`;
    }

    // lite mode for test-writer
    return `${header}\n\nisolation scope: Create test files in test/. MAY read src/ files and MAY import from src/ to ensure correct types/interfaces. May create minimal stubs in src/ if needed to make imports work, but do NOT implement real logic.${footer}`;
  }

  if (role === "implementer") {
    // lite mode — session 2 of three-session-tdd-lite: the implementer also
    // fills AC coverage gaps the test-writer left, so a blanket "do not modify
    // test files" would contradict the role-task and test-quality sections.
    if (mode === "lite") {
      return `${header}\n\nisolation scope: Implement source code in src/ to make tests pass. You MAY add tests for acceptance criteria that have no coverage yet; do NOT weaken, delete, or skip existing tests. Run tests frequently to track progress.${footer}`;
    }
    return `${header}\n\nisolation scope: Implement source code in src/ to make tests pass. Do not modify test files. Run tests frequently to track progress.${footer}`;
  }

  if (role === "verifier") {
    return `${header}\n\nisolation scope: Read-only TDD integrity inspection. Review story-scoped test results and test-file modifications. Do NOT apply source or test fixes. You MAY write only the verdict file (.nax-verifier-verdict.json).${footer}`;
  }

  if (role === "single-session") {
    return `${header}\n\nisolation scope: Create test files in test/ directory, then implement source code in src/ to make tests pass. Both directories are in scope for this session.${footer}`;
  }

  // tdd-simple role — no isolation restrictions but still needs the test filter rule
  return `${header}\n\nisolation scope: You may modify both src/ and test/ files. Write failing tests FIRST, then implement to make them pass.${footer}`;
}
