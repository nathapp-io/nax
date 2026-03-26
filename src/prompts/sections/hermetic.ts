/**
 * Hermetic Test Requirement Section
 *
 * Enforces hermetic (no real external I/O) tests for all code-writing roles.
 * Injected by PromptBuilder when testing.hermetic = true (default).
 *
 * Roles that receive this section: test-writer, implementer, tdd-simple, batch, single-session.
 * Roles that do NOT: verifier (read-only, writes no test code).
 */

import type { ProjectProfile } from "../../config/runtime-types";

const HERMETIC_ROLES = new Set(["test-writer", "implementer", "tdd-simple", "batch", "single-session"]);

// Language-specific mocking guidance
const LANGUAGE_GUIDANCE: Record<string, string> = {
  go: "Define interfaces for external dependencies. Use constructor injection. Test with interface mocks — no real I/O in tests.",
  rust: "Use trait objects or generics for external deps. Mock with the mockall crate. Use #[cfg(test)] modules.",
  python:
    "Use dependency injection or unittest.mock.patch. Mock external calls with pytest-mock fixtures. " +
    "Never import side-effectful modules in test scope.",
};

/**
 * Builds the hermetic test requirement section for the prompt.
 *
 * @param profile Optional project profile to derive language-specific mocking guidance
 * @returns Empty string if the role does not write test/source code.
 */
export function buildHermeticSection(
  role: string,
  boundaries: string[] | undefined,
  mockGuidance: string | undefined,
  profile?: ProjectProfile,
): string {
  if (!HERMETIC_ROLES.has(role)) return "";

  let body =
    "Tests must be hermetic — never invoke real external processes or connect to real services during test execution. " +
    "Mock all I/O boundaries: HTTP/gRPC/WebSocket calls, CLI tool spawning (e.g. `Bun.spawn`/`exec`/`execa`), " +
    "database and cache clients (Redis, Postgres, etc.), message queues, and file operations outside the test working directory. " +
    "Use injectable deps, stubs, or in-memory fakes — never real network or process I/O.";

  if (boundaries && boundaries.length > 0) {
    const list = boundaries.map((b) => `\`${b}\``).join(", ");
    body += `\n\nProject-specific boundaries to mock: ${list}.`;
  }

  // Explicit mockGuidance takes precedence over language-derived guidance
  if (mockGuidance) {
    body += `\n\nMocking guidance for this project: ${mockGuidance}`;
  } else if (profile?.language && profile.language in LANGUAGE_GUIDANCE) {
    // Derive language-specific guidance when no explicit guidance provided
    body += `\n\nMocking guidance for this project: ${LANGUAGE_GUIDANCE[profile.language]}`;
  }

  return `# Hermetic Test Requirement\n\n${body}`;
}
