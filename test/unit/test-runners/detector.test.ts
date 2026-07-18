/**
 * Tests for test framework detector utilities.
 */

import { describe, expect, test } from "bun:test";
import { buildTestFrameworkHint, detectFramework } from "../../../src/test-runners/detector";

describe("buildTestFrameworkHint", () => {
  test("returns neutral hint for empty command (#543)", () => {
    expect(buildTestFrameworkHint("")).toBe("Use your project's test framework");
  });

  test("returns Bun hint for bun test command", () => {
    expect(buildTestFrameworkHint("bun test")).toBe("Use Bun test (describe/test/expect)");
    expect(buildTestFrameworkHint("bun test test/unit/")).toBe("Use Bun test (describe/test/expect)");
  });

  test("returns pytest hint", () => {
    expect(buildTestFrameworkHint("pytest")).toBe("Use pytest");
    expect(buildTestFrameworkHint("pytest -x src/")).toBe("Use pytest");
    expect(buildTestFrameworkHint("python -m pytest")).toBe("Use pytest");
  });

  test("returns cargo test hint", () => {
    expect(buildTestFrameworkHint("cargo test")).toBe("Use Rust's cargo test");
  });

  test("returns go test hint", () => {
    expect(buildTestFrameworkHint("go test ./...")).toBe("Use Go's testing package");
  });

  test("returns vitest hint", () => {
    expect(buildTestFrameworkHint("npx vitest")).toBe("Use Vitest (describe/test/expect)");
    expect(buildTestFrameworkHint("vitest run")).toBe("Use Vitest (describe/test/expect)");
  });

  test("returns jest hint for jest commands", () => {
    expect(buildTestFrameworkHint("npx jest")).toBe("Use Jest (describe/test/expect)");
    expect(buildTestFrameworkHint("npm test")).toBe("Use Jest (describe/test/expect)");
    expect(buildTestFrameworkHint("yarn test")).toBe("Use Jest (describe/test/expect)");
  });

  test("returns generic hint for unknown commands", () => {
    expect(buildTestFrameworkHint("ruby -Itest test/all.rb")).toBe("Use your project's test framework");
    expect(buildTestFrameworkHint("dotnet test")).toBe("Use your project's test framework");
  });

  test("trims leading/trailing whitespace before matching", () => {
    expect(buildTestFrameworkHint("  pytest -v  ")).toBe("Use pytest");
    expect(buildTestFrameworkHint("  go test ./...  ")).toBe("Use Go's testing package");
  });
});

describe("detectFramework — rust & mocha", () => {
  test("detects cargo test result line as rust", () => {
    const output = `test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s`;
    expect(detectFramework(output)).toBe("rust");
  });

  test("detects a rust panic line as rust", () => {
    expect(detectFramework("thread 'x' panicked at src/lib.rs:1:1:")).toBe("rust");
  });

  test("detects mocha output as mocha, not bun (despite the check glyph)", () => {
    const output = `
  MySuite
    ✓ passes

  1 passing (12ms)
  1 failing
`.trim();
    expect(detectFramework(output)).toBe("mocha");
  });

  test("cypress-style mocha output detects as mocha", () => {
    const output = `
  2 passing (1s)
  1 failing

  1) login flow works:
     AssertionError: expected true to be false
      at Context.eval (cypress/e2e/login.cy.js:12:10)
`.trim();
    expect(detectFramework(output)).toBe("mocha");
  });
});
