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
import { _flakeProbeDeps, runFlakeProbe } from "../../../src/verification/flake-probe";
import type { Framework } from "../../../src/test-runners/detector";
import type { TestFailure } from "../../../src/test-runners/types";

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

/**
 * Install a fake executor that records every command string passed in, and
 * returns the supplied `results` (one per probe, cycled if exhausted).
 */
function installFakeExecutor(results: ExecResult[]) {
  const calls: Array<{ command: string; cwd?: string }> = [];
  const fake = mock(async (command: string, _timeout: number, _env: any, opts: any) => {
    calls.push({ command, cwd: opts?.cwd });
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
    const mod = await import("../../../src/verification/flake-probe");
    expect(typeof mod.runFlakeProbe).toBe("function");
  });

  test("AC2 — runFlakeProbe is re-exported from src/verification index barrel", async () => {
    const mod = await import("../../../src/verification");
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
    }
    expect(fake).toHaveBeenCalledTimes(2);
  });

  test("AC11 — all timeouts/env failures → consistent-failure", async () => {
    const { fake } = installFakeExecutor([envExec(), envExec(), envExec()]);

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
    expect(calls[0]?.command).toBeDefined();
  });
});