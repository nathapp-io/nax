/**
 * Tests for test framework detector utilities.
 */

import { describe, expect, test } from "bun:test";
import { buildTestFrameworkHint, detectFramework, stripAnsi } from "@/test-runners/detector";

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

  // #1939: a scoped command commonly carries leading env assignments (this
  // repo's testScoped is "CI=1 AGENT=1 bun test --timeout=60000 {{files}}"),
  // which used to miss every branch below and fall through to the generic hint.
  test("strips leading env assignments before matching bun", () => {
    expect(buildTestFrameworkHint("CI=1 AGENT=1 bun test --timeout=60000 /abs/x.test.ts")).toBe(
      "Use Bun test (describe/test/expect)",
    );
    expect(buildTestFrameworkHint("CI=1 bun test")).toBe("Use Bun test (describe/test/expect)");
  });

  test("strips leading env assignments before matching pytest", () => {
    expect(buildTestFrameworkHint("PYTHONPATH=. CI=1 pytest -x src/")).toBe("Use pytest");
  });

  test("falls through to the generic hint when the command is only env assignments (#543)", () => {
    expect(buildTestFrameworkHint("CI=1 AGENT=1")).toBe("Use your project's test framework");
  });

  test("empty command still returns the generic hint unchanged (#543)", () => {
    expect(buildTestFrameworkHint("")).toBe("Use your project's test framework");
    expect(buildTestFrameworkHint("   ")).toBe("Use your project's test framework");
  });
});

describe("detectFramework — rust & mocha", () => {
  test("detects cargo test result line as rust", () => {
    const output = "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s";
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

  test("detects ANSI-colored mocha output as mocha, not bun (#bug)", () => {
    const ESC = "\x1b[32m";
    const R = "\x1b[0m";
    const output = `
  MySuite
    ${ESC}✓${R} passes

  ${ESC}  1 passing${R}
  ${"\x1b[31m"}  1 failing${R}
`.trim();
    expect(detectFramework(output)).toBe("mocha");
  });
});

describe("stripAnsi", () => {
  test("strips ANSI color escape sequences", () => {
    const input = "\x1b[32m  1 passing\x1b[0m\n\x1b[31m  1 failing\x1b[0m";
    expect(stripAnsi(input)).toBe("  1 passing\n  1 failing");
  });

  test("leaves plain text untouched", () => {
    const input = "  1 passing\n  1 failing";
    expect(stripAnsi(input)).toBe(input);
  });
});
