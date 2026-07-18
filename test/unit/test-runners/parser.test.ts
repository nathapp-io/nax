import { describe, expect, test } from "bun:test";
import { analyzeTestExitCode, parseTestOutput } from "@/test-runners";

describe("pytest output — structured error/stack extraction", () => {
  test("extracts stackTrace file:line reference from verbose FAILURES block", () => {
    const output = `
================================= FAILURES =================================
________________________________ test_subtract _____________________________

    def test_subtract():
>       assert subtract(5, 3) == 1
E       AssertionError: assert 2 == 1
E       assert 2 == 1

tests/test_calculator.py:10: AssertionError
=========================== short test summary info ============================
FAILED tests/test_calculator.py::test_subtract - AssertionError: assert 2 == 1
========================= 1 failed, 1 passed in 0.05s =========================
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe("tests/test_calculator.py");
    expect(result.failures[0].testName).toBe("test_subtract");
    expect(result.failures[0].error).toBe("AssertionError: assert 2 == 1");
    expect(result.failures[0].stackTrace).toContain("tests/test_calculator.py:10");
  });

  test("extracts stackTrace for multiple pytest failures in a single verbose block", () => {
    const output = `
================================= FAILURES =================================
_________________________________ test_a ___________________________________

    def test_a():
>       assert 1 == 2
E       AssertionError: assert 1 == 2

tests/test_foo.py:5: AssertionError

_________________________________ test_b ___________________________________

    def test_b():
>       assert "hello" == "world"
E       AssertionError: assert 'hello' == 'world'
E         - world
E         + hello

tests/test_foo.py:9: AssertionError
=========================== short test summary info ============================
FAILED tests/test_foo.py::test_a - AssertionError: assert 1 == 2
FAILED tests/test_foo.py::test_b - AssertionError: assert 'hello' == 'world'
========================= 2 failed in 0.03s ================================
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].stackTrace).toContain("tests/test_foo.py:5");
    expect(result.failures[1].stackTrace).toContain("tests/test_foo.py:9");
  });

  test("extracts stackTrace for class-based test methods (dot notation in verbose header)", () => {
    const output = `
================================= FAILURES =================================
___________________ TestCalculator.test_subtract ___________________________

    def test_subtract(self):
>       assert self.calc.subtract(5, 3) == 1
E       AssertionError: assert 2 == 1

tests/test_calculator.py:18: AssertionError
=========================== short test summary info ============================
FAILED tests/test_calculator.py::TestCalculator::test_subtract - AssertionError: assert 2 == 1
========================= 1 failed in 0.05s =========================
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].testName).toBe("TestCalculator > test_subtract");
    expect(result.failures[0].stackTrace).toContain("tests/test_calculator.py:18");
  });

  test("preserves existing behavior when no verbose FAILURES block is present", () => {
    const output = `
FAILED tests/test_foo.py::test_bar - AssertionError: assert 1 == 2
====== 1 failed, 3 passed in 0.42s ======
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].file).toBe("tests/test_foo.py");
    expect(result.failures[0].testName).toBe("test_bar");
    expect(result.failures[0].error).toBe("AssertionError: assert 1 == 2");
  });
});

describe("pytest output — collection/import errors count as failures", () => {
  test("counts pytest 'errors' category in the summary line as failed", () => {
    const output = `
==================================== ERRORS ====================================
______________ ERROR collecting tests/unit/test_alpaca_adapter.py ______________
ImportError while importing test module 'tests/unit/test_alpaca_adapter.py'.
E   ModuleNotFoundError: No module named 'respx'
=========================== short test summary info ============================
ERROR tests/unit/test_alpaca_adapter.py - ImportError while importing test mo...
======================== 230 passed, 10 errors in 5.29s ========================
`.trim();

    const result = parseTestOutput(output);

    expect(result.passed).toBe(230);
    expect(result.failed).toBe(10);
  });

  test("counts errors under a turbo line prefix (monorepo aggregate output)", () => {
    const output = `
stock-portfolio:test: ==================================== ERRORS ====================================
stock-portfolio:test: ______________ ERROR collecting tests/unit/test_alpaca_adapter.py ______________
stock-portfolio:test: E   ModuleNotFoundError: No module named 'respx'
stock-portfolio:test: =========================== short test summary info ============================
stock-portfolio:test: ERROR tests/unit/test_alpaca_adapter.py - ImportError while importing test mo...
stock-portfolio:test: ======================== 230 passed, 10 errors in 5.29s ========================
`.trim();

    const result = parseTestOutput(output);

    expect(result.passed).toBe(230);
    expect(result.failed).toBe(10);
  });

  test("combines failed + errors when both are present", () => {
    const output = `
FAILED tests/test_foo.py::test_bar - AssertionError: assert 1 == 2
=================== 2 failed, 5 passed, 1 error in 0.42s ===================
`.trim();

    const result = parseTestOutput(output);

    expect(result.passed).toBe(5);
    expect(result.failed).toBe(3);
  });

  test("extracts collection errors into structured failures with file paths", () => {
    const output = `
==================================== ERRORS ====================================
______________ ERROR collecting tests/unit/test_alpaca_adapter.py ______________
E   ModuleNotFoundError: No module named 'respx'
=========================== short test summary info ============================
ERROR tests/unit/test_alpaca_adapter.py - ImportError while importing test module
ERROR tests/unit/test_broker_cancel.py - ImportError while importing test module
======================== 230 passed, 2 errors in 5.29s ========================
`.trim();

    const result = parseTestOutput(output);

    const files = result.failures.map((f) => f.file).sort();
    expect(files).toEqual(["tests/unit/test_alpaca_adapter.py", "tests/unit/test_broker_cancel.py"]);
    expect(result.failures.every((f) => f.error.length > 0)).toBe(true);
  });

  test("does NOT count incidental 'N errors' phrasing that is not a pytest summary tail", () => {
    // "4 errors" trails the duration, so it is not a pytest count — must be ignored.
    const output = `
ok - all checks passed in 1.2s (4 errors suppressed)
=========================== short test summary info ============================
3 passed in 1.2s
`.trim();

    const result = parseTestOutput(output);

    expect(result.failed).toBe(0);
  });

  test("does NOT manufacture failures from captured app-log lines containing ERROR", () => {
    const output = `
tests/test_app.py::test_run
ERROR app.py:42 something went wrong at runtime
ERROR    root:client.py:13 connection reset
=================================== 5 passed in 1.10s ===================================
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(0);
    expect(result.failed).toBe(0);
  });

  test("analyzeTestExitCode does NOT classify collection errors as environmental", () => {
    const output = `
=========================== short test summary info ============================
ERROR tests/unit/test_alpaca_adapter.py - ImportError while importing test module
======================== 230 passed, 10 errors in 5.29s ========================
`.trim();

    const analysis = analyzeTestExitCode(output, 1);

    expect(analysis.failCount).toBe(10);
    expect(analysis.allTestsPassed).toBe(false);
    expect(analysis.isEnvironmentalFailure).toBe(false);
  });
});

describe("go test output — structured error/file/stack extraction", () => {
  test("extracts file and error message from indented lines after --- FAIL:", () => {
    const output = `
--- FAIL: TestAdd (0.00s)
    calculator_test.go:12: Expected 4 but got 3
ok  	example.com/calc	0.001s
FAIL	example.com/calc	0.001s
FAIL
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].testName).toBe("TestAdd");
    expect(result.failures[0].file).toBe("calculator_test.go");
    expect(result.failures[0].error).toBe("Expected 4 but got 3");
    expect(result.failures[0].stackTrace).toContain("calculator_test.go:12: Expected 4 but got 3");
  });

  test("extracts multiple error lines per failure into stackTrace", () => {
    const output = `
--- FAIL: TestFoo (0.00s)
    foo_test.go:20: first error
    foo_test.go:21: second error
--- FAIL: TestBar (0.00s)
    bar_test.go:8: nil pointer dereference
FAIL	example.com/pkg	0.002s
FAIL
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(2);
    expect(result.failures[0].testName).toBe("TestFoo");
    expect(result.failures[0].error).toBe("first error");
    expect(result.failures[0].stackTrace).toHaveLength(2);
    expect(result.failures[0].stackTrace[0]).toBe("foo_test.go:20: first error");
    expect(result.failures[0].stackTrace[1]).toBe("foo_test.go:21: second error");

    expect(result.failures[1].testName).toBe("TestBar");
    expect(result.failures[1].file).toBe("bar_test.go");
    expect(result.failures[1].error).toBe("nil pointer dereference");
  });

  test("extracts subtest names and preserves existing test count behavior", () => {
    const output = `
--- FAIL: TestSuite/SubTest_one (0.00s)
    suite_test.go:45: unexpected value
ok  	example.com/pkg	0.000s
FAIL	example.com/pkg	0.001s
1 fail
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].testName).toBe("TestSuite/SubTest_one");
    expect(result.failures[0].file).toBe("suite_test.go");
    expect(result.failures[0].error).toBe("unexpected value");
    expect(result.failed).toBe(1);
  });

  test("falls back to unknown/Unknown error when no indented error lines are present", () => {
    const output = `
--- FAIL: TestMissingDetail (0.00s)
FAIL	example.com/pkg	0.001s
FAIL
`.trim();

    const result = parseTestOutput(output);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].testName).toBe("TestMissingDetail");
    expect(result.failures[0].file).toBe("unknown");
    expect(result.failures[0].error).toBe("Unknown error");
    expect(result.failures[0].stackTrace).toHaveLength(0);
  });
});

describe("parseTestOutput — rust & mocha dispatch", () => {
  test("routes cargo output through the rust parser", () => {
    const output = `
---- tests::t stdout ----
thread 'tests::t' panicked at src/x.rs:2:3:
boom

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.0s
`.trim();
    const s = parseTestOutput(output);
    expect(s.failed).toBe(1);
    expect(s.failures[0].file).toBe("src/x.rs");
  });

  test("routes mocha output through the mocha parser", () => {
    const output = `
  1 passing (1ms)
  1 failing

  1) suite t:
     Error: nope
      at Context.<anonymous> (test/a.test.js:1:1)
`.trim();
    const s = parseTestOutput(output);
    expect(s.failed).toBe(1);
    expect(s.failures[0].file).toBe("test/a.test.js");
  });
});
