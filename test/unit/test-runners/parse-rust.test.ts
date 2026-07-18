import { describe, expect, test } from "bun:test";
import { parseRustTestOutput } from "@/test-runners/parse-rust";

describe("parseRustTestOutput", () => {
  test("extracts count + panic file:line from a single-binary failure", () => {
    const output = `
running 3 tests
test tests::test_ok ... ok
test tests::test_add ... FAILED

failures:

---- tests::test_add stdout ----
thread 'tests::test_add' panicked at src/lib.rs:15:9:
assertion \`left == right\` failed
  left: 3
  right: 4

failures:
    tests::test_add

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`.trim();
    const summary = parseRustTestOutput(output);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].testName).toBe("tests::test_add");
    expect(summary.failures[0].file).toBe("src/lib.rs");
    expect(summary.failures[0].error).toContain("assertion");
    expect(summary.failures[0].stackTrace).toContain("src/lib.rs:15");
  });

  test("sums counts across multiple test binaries", () => {
    const output = `
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
test result: FAILED. 3 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
`.trim();
    const summary = parseRustTestOutput(output);
    expect(summary.passed).toBe(8);
    expect(summary.failed).toBe(2);
  });

  test("passing-only run yields no failures", () => {
    const output = `test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s`;
    const summary = parseRustTestOutput(output);
    expect(summary.passed).toBe(10);
    expect(summary.failed).toBe(0);
    expect(summary.failures).toEqual([]);
  });

  test("degrades to test-line names when no stdout blocks present", () => {
    const output = `
test tests::broken ... FAILED

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`.trim();
    const summary = parseRustTestOutput(output);
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0].testName).toBe("tests::broken");
    expect(summary.failures[0].file).toBe("unknown");
  });
});
