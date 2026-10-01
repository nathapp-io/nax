/**
 * Tests for src/acceptance/test-path.ts and src/acceptance/generator.ts helpers.
 *
 * Covers:
 * - acceptanceTestFilename returns correct dot-prefixed filenames per language
 * - buildAcceptanceRunCommand builds correct commands per framework
 * - parseAcceptanceCriteria extracts AC lines from spec markdown
 */

import { describe, expect, test } from "bun:test";
import { acceptanceTestFilename, buildAcceptanceRunCommand, parseAcceptanceCriteria } from "@/acceptance";

describe("acceptanceTestFilename", () => {
  test.each([
    ["no argument", ".nax-acceptance.test.ts", () => acceptanceTestFilename()],
    ["undefined", ".nax-acceptance.test.ts", () => acceptanceTestFilename(undefined)],
    ["go", ".nax-acceptance_test.go", () => acceptanceTestFilename("go")],
    ["python", "_nax_acceptance_test.py", () => acceptanceTestFilename("python")],
    ["rust", ".nax-acceptance.rs", () => acceptanceTestFilename("rust")],
    ["unknown language", ".nax-acceptance.test.ts", () => acceptanceTestFilename("ruby")],
  ])("returns correct filename for %s", (_label, expected, call) => {
    expect(call()).toBe(expected);
  });

  test("is case-insensitive for language", () => {
    expect(acceptanceTestFilename("GO")).toBe(".nax-acceptance_test.go");
    expect(acceptanceTestFilename("Python")).toBe("_nax_acceptance_test.py");
  });
});

/**
 * US-001: `buildAcceptanceRunCommand` returns ONE shell command string. Every
 * expectation below is the exact string handed to `/bin/sh -c`, so the
 * quotes are part of the contract (`shellQuoteArg` single-quotes every argv
 * word of the framework default).
 */
describe("buildAcceptanceRunCommand", () => {
  test("US-001 AC7: returns the quote-joined bun default when no framework or override is given", () => {
    const cmd = buildAcceptanceRunCommand("/project/.nax-acceptance.test.ts");
    expect(cmd).toBe("'bun' 'test' '/project/.nax-acceptance.test.ts' '--timeout=60000'");
  });

  test.each([
    [
      "vitest",
      "/pkg/.nax-acceptance.test.ts",
      "vitest" as const,
      "'npx' 'vitest' 'run' '/pkg/.nax-acceptance.test.ts'",
    ],
    [
      "jest",
      "/pkg/.nax-acceptance.test.ts",
      "jest" as const,
      // AC8
      "'npx' 'jest' '/pkg/.nax-acceptance.test.ts'",
    ],
    ["pytest", "/pkg/.nax-acceptance.test.py", "pytest" as const, "'pytest' '/pkg/.nax-acceptance.test.py'"],
    ["go-test", "/pkg/.nax-acceptance_test.go", "go-test" as const, "'go' 'test' '/pkg/.nax-acceptance_test.go'"],
    ["cargo-test", "/pkg/.nax-acceptance.rs", "cargo-test" as const, "'cargo' 'test' '--test' 'acceptance'"],
  ])(
    "US-001 AC8: quote-joins the %s framework default argv into one command string",
    (_framework, file, fw, expected) => {
      expect(buildAcceptanceRunCommand(file, fw)).toBe(expected);
    },
  );

  test.each([
    ["{{FILE}}", "bun test {{FILE}}"],
    ["{{file}}", "bun test {{file}}"],
    ["{{files}}", "bun test {{files}}"],
  ])("US-001: substitutes %s with the shell-quoted test path", (_placeholder, override) => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", undefined, override);
    expect(cmd).toBe("bun test '/pkg/.nax-acceptance.test.ts'");
  });

  test("US-001 AC1: keeps a leading env assignment and the override's own arguments unquoted", () => {
    const cmd = buildAcceptanceRunCommand(
      "/pkg/.nax-acceptance.test.ts",
      undefined,
      "KODA_DB_TESTS=1 npx jest -c j.js {{FILE}}",
    );
    expect(cmd).toBe("KODA_DB_TESTS=1 npx jest -c j.js '/pkg/.nax-acceptance.test.ts'");
  });

  test("US-001 AC2: keeps a substituted path containing spaces as a single shell word", () => {
    const cmd = buildAcceptanceRunCommand("/pkg with spaces/.nax-acceptance.test.ts", undefined, "bun test {{FILE}}");
    expect(cmd).toBe("bun test '/pkg with spaces/.nax-acceptance.test.ts'");
  });

  test("US-001 AC3: shell-quotes an embedded single quote so it cannot end the shell word", () => {
    const cmd = buildAcceptanceRunCommand("/p/it's/.nax-acceptance.test.ts", undefined, "bun test {{file}}");
    expect(cmd).toBe("bun test '/p/it'\\''s/.nax-acceptance.test.ts'");
  });

  test("US-001 AC3 boundary: $ and backticks in the path stay literal inside the quotes", () => {
    const cmd = buildAcceptanceRunCommand("/p/$HOME`boom`/.nax-acceptance.test.ts", undefined, "bun test {{FILE}}");
    expect(cmd).toBe("bun test '/p/$HOME`boom`/.nax-acceptance.test.ts'");
  });

  test("US-001 AC4: leaves the && operator in the override unquoted", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/a.test.ts", undefined, "cd sub && bun test {{files}}");
    expect(cmd).toBe("cd sub && bun test '/pkg/a.test.ts'");
  });

  test("US-001 AC4 boundary: every placeholder occurrence in the override is substituted", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/a.test.ts", undefined, "bun test {{FILE}} && bun test {{file}}");
    expect(cmd).toBe("bun test '/pkg/a.test.ts' && bun test '/pkg/a.test.ts'");
  });

  test("US-001 AC5: trims surrounding whitespace from the override", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/a.test.ts", undefined, "  bun test {{FILE}}  ");
    expect(cmd).toBe("bun test '/pkg/a.test.ts'");
  });

  test("US-001 AC6: an override without a placeholder runs as written, with no test path appended", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/a.test.ts", undefined, "bun test");
    expect(cmd).toBe("bun test");
  });

  test("US-001 AC6 boundary: an override without a placeholder ignores the framework default", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/a.test.ts", "jest", "bun test");
    expect(cmd).toBe("bun test");
  });

  test("US-001 AC7 boundary: an override carrying a placeholder wins over the framework default", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/a.test.ts", "jest", "bun test {{FILE}}");
    expect(cmd).toBe("bun test '/pkg/a.test.ts'");
  });
});

describe("parseAcceptanceCriteria", () => {
  test("extracts AC lines from markdown list", () => {
    const spec = `
## Acceptance Criteria
- AC-1: System should handle empty input
- AC-2: set(key, value, ttl) expires after ttl milliseconds
`;
    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria).toHaveLength(2);
    expect(criteria[0].id).toBe("AC-1");
    expect(criteria[0].text).toBe("System should handle empty input");
    expect(criteria[1].id).toBe("AC-2");
  });

  test("extracts AC lines without list marker", () => {
    const spec = "AC-1: Plain criterion\nAC-2: Another criterion";
    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria).toHaveLength(2);
    expect(criteria[0].id).toBe("AC-1");
  });

  test("handles checkbox-style AC lines", () => {
    const spec = "- [ ] AC-1: Todo criterion\n- [x] AC-2: Done criterion";
    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria).toHaveLength(2);
    expect(criteria[0].text).toBe("Todo criterion");
  });

  test("normalizes AC IDs to uppercase", () => {
    const spec = "- ac-1: lowercase id";
    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria[0].id).toBe("AC-1");
  });

  test("returns empty array when no AC lines found", () => {
    const spec = "# Just a heading\nSome text without AC.";
    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria).toHaveLength(0);
  });

  test("assigns line numbers", () => {
    const spec = "Line 1\nAC-1: Criterion\nLine 3\nAC-2: Another";
    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria[0].lineNumber).toBe(2);
    expect(criteria[1].lineNumber).toBe(4);
  });
});
