/**
 * Tests for src/acceptance/test-path.ts and src/acceptance/generator.ts helpers.
 *
 * Covers:
 * - acceptanceTestFilename returns correct dot-prefixed filenames per language
 * - buildAcceptanceRunCommand builds correct commands per framework
 * - parseAcceptanceCriteria extracts AC lines from spec markdown
 */

import { describe, expect, test } from "bun:test";
import {
  acceptanceTestFilename,
  buildAcceptanceRunCommand,
  parseAcceptanceCriteria,
} from "../../../src/acceptance/generator";

describe("acceptanceTestFilename", () => {
  test("returns .nax-acceptance.test.ts when no language is given", () => {
    expect(acceptanceTestFilename()).toBe(".nax-acceptance.test.ts");
  });

  test("returns .nax-acceptance.test.ts for undefined language", () => {
    expect(acceptanceTestFilename(undefined)).toBe(".nax-acceptance.test.ts");
  });

  test("returns .nax-acceptance_test.go for go", () => {
    expect(acceptanceTestFilename("go")).toBe(".nax-acceptance_test.go");
  });

  test("returns .nax-acceptance.test.py for python", () => {
    expect(acceptanceTestFilename("python")).toBe(".nax-acceptance.test.py");
  });

  test("returns .nax-acceptance.rs for rust", () => {
    expect(acceptanceTestFilename("rust")).toBe(".nax-acceptance.rs");
  });

  test("is case-insensitive for language", () => {
    expect(acceptanceTestFilename("GO")).toBe(".nax-acceptance_test.go");
    expect(acceptanceTestFilename("Python")).toBe(".nax-acceptance.test.py");
  });

  test("returns .nax-acceptance.test.ts for unknown language", () => {
    expect(acceptanceTestFilename("ruby")).toBe(".nax-acceptance.test.ts");
  });
});

describe("buildAcceptanceRunCommand", () => {
  test("returns bun test command by default", () => {
    const cmd = buildAcceptanceRunCommand("/project/.nax-acceptance.test.ts");
    expect(cmd).toEqual(["bun", "test", "/project/.nax-acceptance.test.ts", "--timeout=60000"]);
  });

  test("uses vitest for vitest framework", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", "vitest");
    expect(cmd).toEqual(["npx", "vitest", "run", "/pkg/.nax-acceptance.test.ts"]);
  });

  test("uses jest for jest framework", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", "jest");
    expect(cmd).toEqual(["npx", "jest", "/pkg/.nax-acceptance.test.ts"]);
  });

  test("uses pytest for pytest framework", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.py", "pytest");
    expect(cmd).toEqual(["pytest", "/pkg/.nax-acceptance.test.py"]);
  });

  test("uses go test for go-test framework", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance_test.go", "go-test");
    expect(cmd).toEqual(["go", "test", "/pkg/.nax-acceptance_test.go"]);
  });

  test("uses cargo test for cargo-test framework", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.rs", "cargo-test");
    expect(cmd).toEqual(["cargo", "test", "--test", "acceptance"]);
  });

  test("substitutes {{FILE}} in command override", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", undefined, "bun test {{FILE}}");
    expect(cmd).toEqual(["bun", "test", "/pkg/.nax-acceptance.test.ts"]);
  });

  test("substitutes {{file}} in command override", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", undefined, "bun test {{file}}");
    expect(cmd).toEqual(["bun", "test", "/pkg/.nax-acceptance.test.ts"]);
  });

  test("substitutes {{files}} in command override", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", undefined, "bun test {{files}}");
    expect(cmd).toEqual(["bun", "test", "/pkg/.nax-acceptance.test.ts"]);
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
