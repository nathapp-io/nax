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

describe("buildAcceptanceRunCommand", () => {
  test("returns bun test command by default", () => {
    const cmd = buildAcceptanceRunCommand("/project/.nax-acceptance.test.ts");
    expect(cmd).toEqual(["bun", "test", "/project/.nax-acceptance.test.ts", "--timeout=60000"]);
  });

  test.each([
    [
      "vitest",
      "/pkg/.nax-acceptance.test.ts",
      "vitest" as const,
      ["npx", "vitest", "run", "/pkg/.nax-acceptance.test.ts"],
    ],
    ["jest", "/pkg/.nax-acceptance.test.ts", "jest" as const, ["npx", "jest", "/pkg/.nax-acceptance.test.ts"]],
    ["pytest", "/pkg/.nax-acceptance.test.py", "pytest" as const, ["pytest", "/pkg/.nax-acceptance.test.py"]],
    ["go-test", "/pkg/.nax-acceptance_test.go", "go-test" as const, ["go", "test", "/pkg/.nax-acceptance_test.go"]],
    ["cargo-test", "/pkg/.nax-acceptance.rs", "cargo-test" as const, ["cargo", "test", "--test", "acceptance"]],
  ])("uses %s framework command", (_framework, file, fw, expected) => {
    expect(buildAcceptanceRunCommand(file, fw)).toEqual(expected);
  });

  test.each([
    ["{{FILE}}", "bun test {{FILE}}"],
    ["{{file}}", "bun test {{file}}"],
    ["{{files}}", "bun test {{files}}"],
  ])("substitutes %s in command override", (_placeholder, override) => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", undefined, override);
    expect(cmd).toEqual(["bun", "test", "/pkg/.nax-acceptance.test.ts"]);
  });

  test("keeps a substituted path containing spaces as a single argv element", () => {
    const cmd = buildAcceptanceRunCommand("/pkg with spaces/.nax-acceptance.test.ts", undefined, "bun test {{FILE}}");
    expect(cmd).toEqual(["bun", "test", "/pkg with spaces/.nax-acceptance.test.ts"]);
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
    const spec = `AC-1: Plain criterion\nAC-2: Another criterion`;
    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria).toHaveLength(2);
    expect(criteria[0].id).toBe("AC-1");
  });

  test("handles checkbox-style AC lines", () => {
    const spec = `- [ ] AC-1: Todo criterion\n- [x] AC-2: Done criterion`;
    const criteria = parseAcceptanceCriteria(spec);
    expect(criteria).toHaveLength(2);
    expect(criteria[0].text).toBe("Todo criterion");
  });

  test("normalizes AC IDs to uppercase", () => {
    const spec = `- ac-1: lowercase id`;
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
