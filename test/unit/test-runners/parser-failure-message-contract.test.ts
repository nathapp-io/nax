/**
 * Cross-framework contract: when a runner reports two distinguishable
 * failures, each parsed failure carries ITS OWN message.
 *
 * Bun's layout prints a failure's message BEFORE the line naming the test;
 * every other supported runner prints it after. A parser written against the
 * wrong direction still produces the right COUNT and the right NAMES — only
 * the message is wrong, and it is wrong by one. That is invisible to any
 * assertion on `file`/`testName`, which is why the Bun defect survived: its
 * describe block asserted exactly those two fields and never `error`.
 *
 * Each fixture below therefore contains two failures whose messages are
 * mutually exclusive, so a borrowed message is a hard failure rather than a
 * near-miss. Adding a framework to parseTestOutput means adding a row here.
 */
import { describe, expect, test } from "bun:test";
import { parseTestOutput } from "@/test-runners";

interface Case {
  framework: string;
  output: string;
  /** testName -> a substring that appears ONLY in that failure's own message. */
  expected: Record<string, string>;
}

const CASES: Case[] = [
  {
    framework: "bun",
    output: [
      "g.test.ts:",
      "error: expect(received).toBe(expected)",
      "",
      "Expected: 4",
      "Received: 3",
      "      at <anonymous> (/abs/g.test.ts:2:45)",
      "(fail) alpha [0.12ms]",
      "error: expect(received).toBe(expected)",
      "",
      'Expected: "b"',
      'Received: "a"',
      "      at <anonymous> (/abs/g.test.ts:3:44)",
      "(fail) beta [1.17ms]",
      "",
      " 0 pass",
      " 2 fail",
    ].join("\n"),
    expected: { alpha: "Expected: 4", beta: 'Expected: "b"' },
  },
  {
    framework: "jest",
    output: [
      "FAIL src/alpha.spec.ts",
      "  ● alpha",
      "",
      "    expected 4 received 3",
      "",
      "  ● beta",
      "",
      '    expected "b" received "a"',
      "",
      "Tests:       2 failed, 0 passed, 2 total",
    ].join("\n"),
    expected: { alpha: "expected 4 received 3", beta: 'expected "b" received "a"' },
  },
  {
    framework: "pytest",
    output: [
      "FAILED tests/test_calc.py::test_alpha - AssertionError: assert 3 == 4",
      'FAILED tests/test_calc.py::test_beta - AssertionError: assert "a" == "b"',
      "=================== 2 failed, 0 passed in 0.42s ===================",
    ].join("\n"),
    expected: { test_alpha: "assert 3 == 4", test_beta: 'assert "a" == "b"' },
  },
  {
    framework: "go",
    output: [
      "--- FAIL: TestAlpha (0.00s)",
      "    calc_test.go:12: expected 4 got 3",
      "--- FAIL: TestBeta (0.00s)",
      '    calc_test.go:20: expected "b" got "a"',
      "FAIL\texample.com/calc\t0.002s",
      "FAIL",
    ].join("\n"),
    expected: { TestAlpha: "expected 4 got 3", TestBeta: 'expected "b" got "a"' },
  },
  {
    framework: "rust",
    output: [
      "---- alpha stdout ----",
      "assertion failed: expected 4 got 3",
      "thread 'alpha' panicked at src/lib.rs:12:5:",
      "---- beta stdout ----",
      'assertion failed: expected "b" got "a"',
      "thread 'beta' panicked at src/lib.rs:20:5:",
      "",
      "test result: FAILED. 0 passed; 2 failed;",
    ].join("\n"),
    expected: { alpha: "expected 4 got 3", beta: 'expected "b" got "a"' },
  },
  {
    framework: "mocha",
    output: [
      "  2 failing",
      "",
      "  1) alpha:",
      "     AssertionError: expected 4 got 3",
      "      at Context.<anonymous> (test/calc.spec.js:5:12)",
      "",
      "  2) beta:",
      '     AssertionError: expected "b" got "a"',
      "      at Context.<anonymous> (test/calc.spec.js:9:12)",
      "",
      "  0 passing",
    ].join("\n"),
    expected: { alpha: "expected 4 got 3", beta: 'expected "b" got "a"' },
  },
];

describe("parseTestOutput — every failure carries its own message", () => {
  for (const c of CASES) {
    test(`${c.framework}: both failures parse with distinct, self-owned messages`, () => {
      const r = parseTestOutput(c.output);
      const names = Object.keys(c.expected);

      expect(r.failures.length).toBeGreaterThanOrEqual(names.length);

      for (const [name, ownToken] of Object.entries(c.expected)) {
        const hit = r.failures.find((f) => f.testName.includes(name));
        expect(hit, `${c.framework}: no failure named ${name}`).toBeDefined();
        expect(hit?.error, `${c.framework}/${name} lost its own message`).toContain(ownToken);
      }

      // The off-by-one signature: two failures sharing one message.
      const messages = names.map((n) => r.failures.find((f) => f.testName.includes(n))?.error);
      expect(new Set(messages).size, `${c.framework}: failures share a message`).toBe(names.length);
    });

    test(`${c.framework}: no failure falls back to a placeholder message`, () => {
      const r = parseTestOutput(c.output);
      for (const f of r.failures) {
        expect(f.error, `${c.framework}/${f.testName}`).not.toBe("Unknown error");
        expect(f.error, `${c.framework}/${f.testName}`).not.toBe("no assertion message captured");
      }
    });
  }
});
