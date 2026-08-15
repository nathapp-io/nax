/**
 * Tests for src/verification/flake-probe.ts
 *
 * Covers AC2–AC11 for the flake-probe isolation re-run mechanic.
 *
 * Mock strategy: `_flakeProbeDeps.execute` is the injectable seam so the
 * verdict-logic tests don't need to mock `_executorDeps.spawn` for the
 * `executeWithTimeout` wrapper. The command-construction tests observe the
 * command passed to the mocked `execute` to verify AC3–AC6.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Framework } from "@/test-runners/detector";
import type { TestFailure } from "@/test-runners/types";
import { _flakeProbeDeps, buildIsolationCommand, escapeRegex, runFlakeProbe } from "@/verification";

function makeFailure(overrides: Partial<TestFailure> = {}): TestFailure {
  return {
    file: "src/foo.test.ts",
    testName: "should handle edge case",
    error: "expected true to equal false",
    stackTrace: [],
    ...overrides,
  };
}

type ExecResult = {
  success: boolean;
  timeout: boolean;
  countsTowardEscalation: boolean;
};

function okExec(): ExecResult {
  return { success: true, timeout: false, countsTowardEscalation: true };
}
function failExec(): ExecResult {
  return { success: false, timeout: false, countsTowardEscalation: true };
}
function envExec(): ExecResult {
  return { success: false, timeout: true, countsTowardEscalation: false };
}
type ExecResultWithOutput = ExecResult & { output?: string };
function noTestsExec(): ExecResultWithOutput {
  // Mirrors a Go probe built from a space-containing subtest name: Go's -run
  // filter doesn't match anything, the process exits 0, and it prints this
  // marker — countsTowardEscalation is true (the executor ran fine) but zero
  // tests actually executed.
  return { success: true, timeout: false, countsTowardEscalation: true, output: "no tests to run" };
}

/**
 * Install a fake executor that records every command string passed in, and
 * returns the supplied `results` (one per probe, cycled if exhausted).
 */
function installFakeExecutor(results: ExecResultWithOutput[]) {
  const calls: Array<{ command: string; cwd?: string; timeoutSeconds: number }> = [];
  const fake = mock(async (command: string, timeoutSeconds: number, _env: any, opts: any) => {
    calls.push({ command, cwd: opts?.cwd, timeoutSeconds });
    return results.shift() ?? failExec();
  });
  _flakeProbeDeps.execute = fake as typeof _flakeProbeDeps.execute;
  return { calls, fake };
}

const realExecute = _flakeProbeDeps.execute;

afterEach(() => {
  // Restore to default (real executeWithTimeout) between tests so tests
  // don't leak mocks via the shared module instance.
  _flakeProbeDeps.execute = realExecute;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — importability
// ─────────────────────────────────────────────────────────────────────────────

describe("runFlakeProbe — export surface (AC2)", () => {
  test("AC2 — runFlakeProbe is importable from src/verification/flake-probe", async () => {
    // Deliberately the leaf module path (not the "@/verification" barrel) — this
    // test's whole point is verifying the leaf export, exercised again from the
    // barrel below.
    const mod = await import("../../../src/verification/flake-probe");
    expect(typeof mod.runFlakeProbe).toBe("function");
  });

  test("AC2 — runFlakeProbe is re-exported from src/verification index barrel", async () => {
    const mod = await import("@/verification");
    expect(typeof (mod as any).runFlakeProbe).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3, AC4, AC5, AC6 — isolation command construction
// ─────────────────────────────────────────────────────────────────────────────

describe("runFlakeProbe — isolation command construction", () => {
  const FRAMEWORKS: Framework[] = ["bun", "jest", "vitest"];

  test.each(FRAMEWORKS)(
    "AC3 — framework=%s builds isolation command with base + file + name filter",
    async (framework) => {
      const { calls } = installFakeExecutor([okExec()]);

      await runFlakeProbe({
        framework,
        baseCommand: "bun test",
        failure: makeFailure({ file: "src/foo.test.ts", testName: "should work" }),
        cwd: "/tmp/probe",
        probeRuns: 1,
        probeTimeoutSeconds: 30,
      });

      expect(calls.length).toBe(1);
      const cmd = calls[0]?.command ?? "";
      expect(cmd.startsWith("bun test")).toBe(true);
      expect(cmd).toContain("src/foo.test.ts");
      expect(cmd).toContain("should work");
      expect(cmd).toContain("-t");
    },
  );

  test("AC4 — pytest builds '<file>::<testName>' address", async () => {
    const { calls } = installFakeExecutor([okExec()]);

    await runFlakeProbe({
      framework: "pytest",
      baseCommand: "pytest",
      failure: makeFailure({ file: "tests/test_foo.py", testName: "test_handles_edge_case" }),
      cwd: "/tmp/probe",
      probeRuns: 1,
      probeTimeoutSeconds: 30,
    });

    const cmd = calls[0]?.command ?? "";
    expect(cmd).toContain("tests/test_foo.py::test_handles_edge_case");
  });

  test("AC5 — go uses anchored run filter '^…$'", async () => {
    const { calls } = installFakeExecutor([okExec()]);

    await runFlakeProbe({
      framework: "go",
      baseCommand: "go test",
      failure: makeFailure({ file: "pkg/foo/foo_test.go", testName: "TestFoo" }),
      cwd: "/tmp/probe",
      probeRuns: 1,
      probeTimeoutSeconds: 30,
    });

    const cmd = calls[0]?.command ?? "";
    expect(cmd).toContain("-run '^TestFoo$'");
  });

  test("AC6 — regex metacharacters in test name are escaped for -t filter", async () => {
    const { calls } = installFakeExecutor([okExec()]);

    await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure({ file: "src/foo.test.ts", testName: "handles (edge) case?" }),
      cwd: "/tmp/probe",
      probeRuns: 1,
      probeTimeoutSeconds: 30,
    });

    const cmd = calls[0]?.command ?? "";
    expect(cmd).toContain("\\(");
    expect(cmd).toContain("\\)");
    expect(cmd).toContain("\\?");
    expect(cmd).toContain("handles");
    expect(cmd).toContain("edge");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7, AC8, AC9, AC10, AC11 — verdict logic
// ─────────────────────────────────────────────────────────────────────────────

describe("runFlakeProbe — verdict logic", () => {
  test("AC7 — first run fails, second passes → flaky with probeRuns=2, probePasses=1", async () => {
    const { fake } = installFakeExecutor([failExec(), okExec()]);

    const result = await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/probe",
      probeRuns: 2,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("flaky");
    if (result.verdict === "flaky") {
      expect(result.probeRuns).toBe(2);
      expect(result.probePasses).toBe(1);
      expect(result.attributableRuns).toBe(2);
    }
    expect(fake).toHaveBeenCalledTimes(2);
  });

  test("AC8 — every run fails → consistent-failure", async () => {
    const { fake } = installFakeExecutor([failExec(), failExec(), failExec()]);

    const result = await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/probe",
      probeRuns: 3,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("consistent-failure");
    if (result.verdict === "consistent-failure") {
      expect(result.probeRuns).toBe(3);
      expect(result.attributableRuns).toBe(3);
    }
    expect(fake).toHaveBeenCalledTimes(3);
  });

  test("AC9 — file='unknown' returns unprobeable and never calls execute", async () => {
    const { fake } = installFakeExecutor([okExec()]);

    const result = await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure({ file: "unknown" }),
      cwd: "/tmp/probe",
      probeRuns: 2,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("unprobeable");
    if (result.verdict === "unprobeable") {
      expect(result.reason).toBeDefined();
    }
    expect(fake).not.toHaveBeenCalled();
  });

  test("AC9 — framework='unknown' returns unprobeable and never calls execute", async () => {
    const { fake } = installFakeExecutor([okExec()]);

    const result = await runFlakeProbe({
      framework: "unknown",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/probe",
      probeRuns: 2,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("unprobeable");
    if (result.verdict === "unprobeable") {
      expect(result.reason).toBeDefined();
    }
    expect(fake).not.toHaveBeenCalled();
  });

  test("AC10 — one env-failure (timeout) + one clean pass → flaky with probePasses=1", async () => {
    const { fake } = installFakeExecutor([envExec(), okExec()]);

    const result = await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/probe",
      probeRuns: 2,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("flaky");
    if (result.verdict === "flaky") {
      expect(result.probeRuns).toBe(2);
      expect(result.probePasses).toBe(1);
      // Only 1 of the 2 raw attempts was attributable (the other was an
      // environmental timeout) — attributableRuns must reflect that, distinct
      // from the raw probeRuns count.
      expect(result.attributableRuns).toBe(1);
    }
    expect(fake).toHaveBeenCalledTimes(2);
  });

  test("BUG-8/AC11 — all timeouts/env failures → unprobeable (non-attributable), not consistent-failure", async () => {
    const { fake } = installFakeExecutor([envExec(), envExec(), envExec()]);

    const result = await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/probe",
      probeRuns: 3,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("unprobeable");
    if (result.verdict === "unprobeable") {
      expect(result.reason).toBeDefined();
    }
    expect(fake).toHaveBeenCalledTimes(3);
  });

  test("uses cwd and probeTimeoutSeconds from input", async () => {
    const { calls } = installFakeExecutor([okExec()]);

    await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/workdir/pkg",
      probeRuns: 1,
      probeTimeoutSeconds: 45,
    });

    expect(calls[0]?.cwd).toBe("/tmp/workdir/pkg");
    expect(calls[0]?.timeoutSeconds).toBe(45);
    expect(calls[0]?.command).toBeDefined();
  });

  test("BUG-8 — executor crash on every probe → unprobeable (non-attributable), not consistent-failure", async () => {
    _flakeProbeDeps.execute = mock(async () => {
      throw new Error("spawn EACCES");
    }) as typeof _flakeProbeDeps.execute;

    const result = await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/probe",
      probeRuns: 2,
      probeTimeoutSeconds: 30,
    });

    // Every probe crashed — environmental, not an attributable pass or fail —
    // so the verdict must be unprobeable, and the rejection must not propagate.
    expect(result.verdict).toBe("unprobeable");
    if (result.verdict === "unprobeable") {
      expect(result.reason).toBeDefined();
    }
  });

  test("executor crash mixed with one clean pass → flaky with probePasses=1", async () => {
    let call = 0;
    _flakeProbeDeps.execute = mock(async () => {
      call += 1;
      if (call === 1) throw new Error("spawn ENOENT");
      return okExec();
    }) as typeof _flakeProbeDeps.execute;

    const result = await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/probe",
      probeRuns: 2,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("flaky");
    if (result.verdict === "flaky") {
      expect(result.probePasses).toBe(1);
    }
  });

  test("BUG-8 — one genuine attributable fail mixed with env failures → consistent-failure (not unprobeable)", async () => {
    const { fake } = installFakeExecutor([envExec(), failExec(), envExec()]);

    const result = await runFlakeProbe({
      framework: "bun",
      baseCommand: "bun test",
      failure: makeFailure(),
      cwd: "/tmp/probe",
      probeRuns: 3,
      probeTimeoutSeconds: 30,
    });

    // At least one probe run genuinely executed and failed (countsTowardEscalation
    // true, success false) — that's an attributable signal, so the verdict stays
    // consistent-failure even though the other two runs were environmental.
    expect(result.verdict).toBe("consistent-failure");
    if (result.verdict === "consistent-failure") {
      expect(result.probeRuns).toBe(3);
      // Only the one genuine fail is attributable — the two env failures
      // consumed a probe slot but confirmed nothing.
      expect(result.attributableRuns).toBe(1);
    }
    expect(fake).toHaveBeenCalledTimes(3);
  });

  // BUG-8: zero-tests-matched runs (exit 0, but the isolation filter matched no
  // tests — e.g. a Go subtest name containing a space) must never count toward
  // attributableRuns. Before the fix, attributableRuns was incremented BEFORE
  // checking probeRanNoTests, so an all-zero-matched batch produced
  // attributableRuns === probeRuns with probePasses === 0 → "consistent-failure",
  // contradicting the documented "unattributable signal never fails a story"
  // contract. It must be "unprobeable" instead.
  test("BUG-8 — all runs report zero tests matched → unprobeable (not consistent-failure)", async () => {
    const { fake } = installFakeExecutor([noTestsExec(), noTestsExec(), noTestsExec()]);

    const result = await runFlakeProbe({
      framework: "go",
      baseCommand: "go test",
      failure: makeFailure({ file: "pkg/foo/foo_test.go", testName: "Test Handles Two Words" }),
      cwd: "/tmp/probe",
      probeRuns: 3,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("unprobeable");
    if (result.verdict === "unprobeable") {
      expect(result.reason).toBeDefined();
    }
    expect(fake).toHaveBeenCalledTimes(3);
  });

  test("BUG-8 — one zero-matched run mixed with one genuine attributable fail → consistent-failure (not unprobeable, not miscounted)", async () => {
    const { fake } = installFakeExecutor([noTestsExec(), failExec()]);

    const result = await runFlakeProbe({
      framework: "go",
      baseCommand: "go test",
      failure: makeFailure({ file: "pkg/foo/foo_test.go", testName: "Test Handles Two Words" }),
      cwd: "/tmp/probe",
      probeRuns: 2,
      probeTimeoutSeconds: 30,
    });

    // Only the genuine fail is attributable — the zero-matched run must not be
    // counted, so the verdict reflects the one real fail, not a misleading
    // "2 attributable runs, 0 passes" or an "unprobeable" that would hide the
    // genuine failure.
    expect(result.verdict).toBe("consistent-failure");
    expect(fake).toHaveBeenCalledTimes(2);
  });

  test("BUG-8 — one zero-matched run mixed with one clean pass → flaky with probePasses=1 (zero-matched run excluded from the count)", async () => {
    const { fake } = installFakeExecutor([noTestsExec(), okExec()]);

    const result = await runFlakeProbe({
      framework: "go",
      baseCommand: "go test",
      failure: makeFailure({ file: "pkg/foo/foo_test.go", testName: "Test Handles Two Words" }),
      cwd: "/tmp/probe",
      probeRuns: 2,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("flaky");
    if (result.verdict === "flaky") {
      expect(result.probePasses).toBe(1);
    }
    expect(fake).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// probeRanNoTests / NO_TESTS_EXECUTED_MARKERS — standalone coverage (BUG-8)
// ─────────────────────────────────────────────────────────────────────────────

describe("runFlakeProbe — zero-tests-matched output detection (BUG-8)", () => {
  test.each(["no tests to run", "No test to run", "NO TESTS TO RUN", "ran 0 tests", "Ran 0 test"])(
    "output %j is treated as a zero-matched probe run",
    async (output) => {
      const { fake } = installFakeExecutor([{ success: true, timeout: false, countsTowardEscalation: true, output }]);

      const result = await runFlakeProbe({
        framework: "go",
        baseCommand: "go test",
        failure: makeFailure({ file: "pkg/foo/foo_test.go", testName: "Test Handles Two Words" }),
        cwd: "/tmp/probe",
        probeRuns: 1,
        probeTimeoutSeconds: 30,
      });

      expect(result.verdict).toBe("unprobeable");
      expect(fake).toHaveBeenCalledTimes(1);
    },
  );

  test("ordinary passing output (no zero-matched marker) is attributable, not treated as zero-matched", async () => {
    installFakeExecutor([
      { success: true, timeout: false, countsTowardEscalation: true, output: "PASS\nok  \tpkg/foo\t0.002s" },
    ]);

    const result = await runFlakeProbe({
      framework: "go",
      baseCommand: "go test",
      failure: makeFailure({ file: "pkg/foo/foo_test.go", testName: "TestFoo" }),
      cwd: "/tmp/probe",
      probeRuns: 1,
      probeTimeoutSeconds: 30,
    });

    expect(result.verdict).toBe("flaky");
    if (result.verdict === "flaky") {
      expect(result.probePasses).toBe(1);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// escapeRegex — standalone unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("escapeRegex", () => {
  test("escapes the standard regex metacharacters", () => {
    expect(escapeRegex("a.b")).toBe("a\\.b");
    expect(escapeRegex("a*b")).toBe("a\\*b");
    expect(escapeRegex("a+b")).toBe("a\\+b");
    expect(escapeRegex("a?b")).toBe("a\\?b");
    expect(escapeRegex("a^b")).toBe("a\\^b");
    expect(escapeRegex("a$b")).toBe("a\\$b");
    expect(escapeRegex("a{b")).toBe("a\\{b");
    expect(escapeRegex("a}b")).toBe("a\\}b");
    expect(escapeRegex("a(b")).toBe("a\\(b");
    expect(escapeRegex("a)b")).toBe("a\\)b");
    expect(escapeRegex("a|b")).toBe("a\\|b");
    expect(escapeRegex("a[b")).toBe("a\\[b");
    expect(escapeRegex("a]b")).toBe("a\\]b");
    expect(escapeRegex("a\\b")).toBe("a\\\\b");
  });

  test("escapes the spec example 'handles (edge) case?' literally", () => {
    expect(escapeRegex("handles (edge) case?")).toBe("handles \\(edge\\) case\\?");
  });

  test("returns the input unchanged when it has no metacharacters", () => {
    expect(escapeRegex("plain_test_name 123")).toBe("plain_test_name 123");
  });

  test("returns an empty string for empty input", () => {
    expect(escapeRegex("")).toBe("");
  });

  test("is meant for raw (un-escaped) test names — applying it twice compounds escapes", () => {
    // Calling escapeRegex on an already-escaped string doubles the backslashes.
    // Document the contract: callers must apply escapeRegex once, to the raw
    // test name from TestFailure.testName.
    expect(escapeRegex("\\.")).toBe("\\\\\\.");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildIsolationCommand — standalone unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("buildIsolationCommand", () => {
  const failure: TestFailure = {
    file: "src/foo.test.ts",
    testName: "should work",
    error: "",
    stackTrace: [],
  };

  test.each<Framework>(["bun", "jest", "vitest"])(
    "framework=%s uses '<base> <quoted file> -t <name>' (SEC-4 — file is shell-quoted)",
    (framework) => {
      expect(buildIsolationCommand("bun test", failure, framework)).toBe("bun test 'src/foo.test.ts' -t 'should work'");
    },
  );

  test("pytest uses '<base> <file>::<name>' addressing", () => {
    expect(buildIsolationCommand("pytest", { ...failure, file: "tests/test_foo.py" }, "pytest")).toBe(
      "pytest 'tests/test_foo.py::should work'",
    );
  });

  test("go uses anchored '-run' filter", () => {
    expect(buildIsolationCommand("go test", { ...failure, file: "pkg/foo/foo_test.go" }, "go")).toBe(
      "go test -run '^should work$'",
    );
  });

  test("escapes regex metacharacters in the name for bun/jest/vitest", () => {
    const cmd = buildIsolationCommand("bun test", { ...failure, testName: "handles (edge) case?" }, "bun");
    expect(cmd).toBe("bun test 'src/foo.test.ts' -t 'handles \\(edge\\) case\\?'");
  });

  test("escapes regex metacharacters in the name for go", () => {
    const cmd = buildIsolationCommand("go test", { ...failure, testName: "Test (Foo)?" }, "go");
    expect(cmd).toBe("go test -run '^Test \\(Foo\\)\\?$'");
  });

  test("does NOT escape the pytest name (pytest uses :: addressing, not regex)", () => {
    const cmd = buildIsolationCommand(
      "pytest",
      { ...failure, file: "tests/foo.py", testName: "test_handles (edge) case?" },
      "pytest",
    );
    expect(cmd).toBe("pytest 'tests/foo.py::test_handles (edge) case?'");
  });

  test("quotes a pytest node id containing a space", () => {
    const cmd = buildIsolationCommand(
      "pytest",
      { ...failure, file: "tests/foo.py", testName: "test handles two words" },
      "pytest",
    );
    expect(cmd).toBe("pytest 'tests/foo.py::test handles two words'");
  });

  test("throws for unsupported frameworks (no silent fallthrough)", () => {
    expect(() => buildIsolationCommand("bun test", failure, "unknown" as Framework)).toThrow(/unsupported framework/);
  });

  test("quotes a multi-word test name so the shell does not word-split it (bun/jest/vitest)", () => {
    const cmd = buildIsolationCommand("bun test", { ...failure, testName: "handles two words" }, "bun");
    expect(cmd).toBe("bun test 'src/foo.test.ts' -t 'handles two words'");
  });

  test("escapes an embedded single quote in the test name (bun/jest/vitest)", () => {
    const cmd = buildIsolationCommand("bun test", { ...failure, testName: "handles it's edge case" }, "bun");
    expect(cmd).toBe("bun test 'src/foo.test.ts' -t 'handles it'\\''s edge case'");
  });

  test("quotes a multi-word test name for go", () => {
    const cmd = buildIsolationCommand("go test", { ...failure, testName: "handles two words" }, "go");
    expect(cmd).toBe("go test -run '^handles two words$'");
  });

  test("SEC-4 — quotes a file path containing shell metacharacters so it cannot escape the isolation command (bun/jest/vitest)", () => {
    const cmd = buildIsolationCommand("bun test", { ...failure, file: "src/foo; rm -rf /tmp/pwned.test.ts" }, "bun");
    expect(cmd).toBe("bun test 'src/foo; rm -rf /tmp/pwned.test.ts' -t 'should work'");
  });

  test("SEC-4 — quotes an embedded single quote in the file path (bun/jest/vitest)", () => {
    const cmd = buildIsolationCommand("bun test", { ...failure, file: "src/it's-a-test.test.ts" }, "bun");
    expect(cmd).toBe("bun test 'src/it'\\''s-a-test.test.ts' -t 'should work'");
  });
});
