/**
 * Tests for test framework detector utilities.
 */

import { describe, expect, test } from "bun:test";
import { detectFramework, stripAnsi } from "@/test-runners/detector";

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
