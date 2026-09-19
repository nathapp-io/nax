/**
 * parseBunOutput — failure-message extraction.
 *
 * Bun prints the code frame, the `error:` line, the Expected/Received pair and
 * the stack BEFORE the `(fail)` line that names the test. Fixtures below are
 * verbatim `bun test v1.4.0` output, so they pin the real layout rather than a
 * reconstruction of it.
 */
import { describe, expect, test } from "bun:test";
import { parseBunOutput } from "@/test-runners/parse-bun";

// Verbatim `bun test g.test.ts` output for a file with two failing tests.
const TWO_FAILURES = [
  "bun test v1.4.0 (34cbb9a40)",
  "",
  "g.test.ts:",
  '1 | import { test, expect } from "bun:test";',
  '2 | test("first failure", () => { expect(1 + 2).toBe(4); });',
  "                                                ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: 4",
  "Received: 3",
  "",
  "      at <anonymous> (/abs/path/g.test.ts:2:45)",
  "(fail) first failure [0.12ms]",
  '1 | import { test, expect } from "bun:test";',
  '2 | test("first failure", () => { expect(1 + 2).toBe(4); });',
  '3 | test("second failure", () => { expect("a").toBe("b"); });',
  "                                               ^",
  "error: expect(received).toBe(expected)",
  "",
  'Expected: "b"',
  'Received: "a"',
  "",
  "      at <anonymous> (/abs/path/g.test.ts:3:44)",
  "(fail) second failure [1.17ms]",
  "",
  " 0 pass",
  " 2 fail",
  " 2 expect() calls",
  "Ran 2 tests across 1 file. [3.00ms]",
].join("\n");

describe("parseBunOutput — each failure carries its OWN message", () => {
  test("the first failure gets its own Expected/Received, not the next failure's code frame", () => {
    const r = parseBunOutput(TWO_FAILURES);

    const first = r.failures.find((f) => f.testName === "first failure");
    expect(first?.error).toContain("expect(received).toBe(expected)");
    expect(first?.error).toContain("Expected: 4");
    expect(first?.error).toContain("Received: 3");
    // The regression: it used to receive the SECOND failure's code frame.
    expect(first?.error).not.toContain("import { test, expect }");
    expect(first?.error).not.toContain('Expected: "b"');
  });

  test("the LAST failure gets a real message rather than the Unknown error fallback", () => {
    const r = parseBunOutput(TWO_FAILURES);

    const last = r.failures.find((f) => f.testName === "second failure");
    expect(last?.error).toContain('Expected: "b"');
    expect(last?.error).toContain('Received: "a"');
    expect(last?.error).not.toBe("Unknown error");
  });

  test("the stack frame above each (fail) line is attributed to that failure", () => {
    const r = parseBunOutput(TWO_FAILURES);

    expect(r.failures.find((f) => f.testName === "first failure")?.stackTrace).toEqual([
      "at <anonymous> (/abs/path/g.test.ts:2:45)",
    ]);
    expect(r.failures.find((f) => f.testName === "second failure")?.stackTrace).toEqual([
      "at <anonymous> (/abs/path/g.test.ts:3:44)",
    ]);
  });

  test("counts and names are unchanged by the extraction rewrite", () => {
    const r = parseBunOutput(TWO_FAILURES);

    expect(r.passed).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.failures.map((f) => f.testName)).toEqual(["first failure", "second failure"]);
    expect(r.failures.every((f) => f.file === "g.test.ts")).toBe(true);
  });
});

describe("parseBunOutput — interleaved stderr is not a failure message", () => {
  test("a (node:NNN) warning between blocks is never adopted as a test's error", () => {
    const output = [
      "test/unit/config/scoped-permissions.test.ts:",
      "error: expect(received).toEqual(expected)",
      "",
      "Expected: 3",
      "Received: 4",
      "",
      "(fail) resolvePermissions > safe > grants read tools only [2.0ms]",
      "(node:79387) Warning: [finish-pr] Failed to write PR title/body",
      "",
      " 0 pass",
      " 1 fail",
    ].join("\n");

    const r = parseBunOutput(output);

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].error).toContain("expect(received).toEqual(expected)");
    expect(r.failures[0].error).not.toContain("finish-pr");
    expect(r.failures[0].error).not.toContain("node:79387");
  });
});

describe("parseBunOutput — no message available", () => {
  test("a (fail) line with no preceding message block reports the explicit placeholder", () => {
    const output = ["test/foo.test.ts:", "(fail) bare failure [1ms]", "", " 0 pass", " 1 fail"].join("\n");

    const r = parseBunOutput(output);

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].error).toBe("no assertion message captured");
  });

  test("a message block is never borrowed across a file header", () => {
    const output = [
      "test/a.test.ts:",
      "error: this belongs to a.test.ts",
      "(fail) failure in a [1ms]",
      "test/b.test.ts:",
      "(fail) failure in b [1ms]",
      "",
      " 0 pass",
      " 2 fail",
    ].join("\n");

    const r = parseBunOutput(output);

    expect(r.failures.find((f) => f.testName === "failure in a")?.error).toBe("this belongs to a.test.ts");
    expect(r.failures.find((f) => f.testName === "failure in b")?.error).toBe("no assertion message captured");
  });
});
