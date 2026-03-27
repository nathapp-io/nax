/**
 * Tests for acceptanceTestFilename() and buildAcceptanceRunCommand()
 * in src/acceptance/generator.ts.
 *
 * US-001 (ACC-002): acceptanceTestFilename() now returns dot-prefixed filenames
 * placed at the package root (.nax-acceptance.test.ts) instead of the old
 * acceptance.test.ts in the .nax/features/ directory.
 */

import { describe, expect, test } from "bun:test";
import { acceptanceTestFilename, buildAcceptanceRunCommand } from "../../../src/acceptance/generator";

// ---------------------------------------------------------------------------
// acceptanceTestFilename — US-001 AC-5
// ---------------------------------------------------------------------------

describe("acceptanceTestFilename — dot-prefixed package-root filenames", () => {
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

  test("does not return the old acceptance.test.ts filename", () => {
    expect(acceptanceTestFilename()).not.toBe("acceptance.test.ts");
    expect(acceptanceTestFilename("go")).not.toBe("acceptance_test.go");
    expect(acceptanceTestFilename("python")).not.toBe("test_acceptance.py");
  });
});

// ---------------------------------------------------------------------------
// buildAcceptanceRunCommand — unchanged behavior
// ---------------------------------------------------------------------------

describe("buildAcceptanceRunCommand — builds correct command for test file", () => {
  test("returns bun test command for .nax-acceptance.test.ts by default", () => {
    const cmd = buildAcceptanceRunCommand("/project/.nax-acceptance.test.ts");
    expect(cmd).toEqual(["bun", "test", "/project/.nax-acceptance.test.ts", "--timeout=60000"]);
  });

  test("uses vitest for vitest framework", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", "vitest");
    expect(cmd).toEqual(["npx", "vitest", "run", "/pkg/.nax-acceptance.test.ts"]);
  });

  test("substitutes {{FILE}} in command override", () => {
    const cmd = buildAcceptanceRunCommand("/pkg/.nax-acceptance.test.ts", undefined, "bun test {{FILE}}");
    expect(cmd).toEqual(["bun", "test", "/pkg/.nax-acceptance.test.ts"]);
  });
});
