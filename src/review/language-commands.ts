/**
 * Language-aware command resolution for review checks
 *
 * Maps programming languages to their idiomatic test/lint/typecheck commands.
 * All commands require binary availability check via Bun.which().
 */

import type { ReviewCheckName } from "./types";

/** Entry in the language command table: required binary + command string */
type LanguageCommandEntry = { binary: string; command: string };

/** Language-aware command lookup table */
const LANGUAGE_COMMANDS: Record<string, Partial<Record<ReviewCheckName, LanguageCommandEntry>>> = {
  go: {
    test: { binary: "go", command: "go test ./..." },
    lint: { binary: "golangci-lint", command: "golangci-lint run" },
    typecheck: { binary: "go", command: "go vet ./..." },
  },
  rust: {
    test: { binary: "cargo", command: "cargo test" },
    lint: { binary: "cargo", command: "cargo clippy -- -D warnings" },
  },
  python: {
    test: { binary: "pytest", command: "pytest" },
    lint: { binary: "ruff", command: "ruff check ." },
    typecheck: { binary: "mypy", command: "mypy ." },
  },
};

/**
 * Returns the idiomatic command for a given language and check type.
 * Checks if the required binary is available via the provided which function.
 * Returns null if the binary is not found or the language/check combo is unsupported.
 *
 * @internal
 */
export function resolveLanguageCommand(
  language: string,
  check: ReviewCheckName,
  which: (command: string) => string | null,
): string | null {
  const languageTable = LANGUAGE_COMMANDS[language];
  if (!languageTable) return null;
  const entry = languageTable[check];
  if (!entry) return null;
  const binaryPath = which(entry.binary);
  if (!binaryPath) return null;
  return entry.command;
}
