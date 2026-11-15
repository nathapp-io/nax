/**
 * `verifyScopedOp` — interruption routing (US-004).
 *
 * Any detector stop (`status === "TIMEOUT" || stopReason !== undefined`) keeps the
 * op from starting its zero-tests full-suite rerun. The verdict, though, follows
 * the aggregate status: a stopped run answers `status: "timeout"` with the detector
 * reason, while a mixed list whose first failing entry failed ordinarily stays a
 * code failure — its findings reach the fixer — and still carries the reason.
 * Both test runs it starts — the scoped command from `selectScopedTests` and the
 * ordinary zero-tests rerun — carry the package-view stall policy.
 *
 * Split from `verify-scoped.test.ts` by concern (the suite-coverage and
 * shape/dep tests stay there) to keep both files within the size target.
 */

import { describe, expect, test } from "bun:test";
import { makeMockCallContext, makeMockRuntime, makeNaxConfig } from "@test/helpers";
import type { ConfigSelector, NaxConfig } from "@/config";
import type { VerifyScopedDeps, VerifyScopedInput, VerifyScopedOutput } from "@/operations";
import { verifyScopedOp } from "@/operations";
import type { CallContext } from "@/operations/types";
import type { PackageView } from "@/runtime";
import type { SelectScopedTestsResult } from "@/test-runners";
import type { GateStallPolicy, GateStopReason } from "@/utils/gate-stall";
import type { VerificationGateOptions, VerificationResult } from "@/verification";

/** The per-package policy the op must forward to every test run it starts. */
const PACKAGE_POLICY: GateStallPolicy = { repeatedLineThreshold: 5, silenceTimeoutSeconds: 0 };

const STOP_REASON: GateStopReason = { kind: "repeated-output", stream: "stdout", count: 5, threshold: 5 };

const INPUT: VerifyScopedInput = { workdir: "/tmp", storyId: "US-004", packagePrefix: "packages/app" };

/** A scoped selection: a real scoped command, not the full suite. */
const SCOPED_SELECTION: SelectScopedTestsResult = {
  effectiveCommand: "bun test test/unit/one.test.ts",
  isFullSuite: false,
  thresholdFallback: false,
  isMonorepoOrchestrator: false,
};

function ctxWithQuality(quality: Partial<NonNullable<NaxConfig["quality"]>> = {}): CallContext {
  const config = makeNaxConfig({ quality });
  const runtime = makeMockRuntime({ config });
  const packageView: PackageView = {
    packageDir: "packages/app",
    relativeFromRoot: "packages/app",
    repoRoot: "/repo",
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
  return makeMockCallContext({ runtime, packageView, storyId: "US-004" });
}

function deps(overrides: Partial<VerifyScopedDeps> = {}): VerifyScopedDeps {
  return {
    selectScopedTests: async () => SCOPED_SELECTION,
    regression: async () => ({
      status: "SUCCESS",
      success: true,
      countsTowardEscalation: true,
      output: "1 pass\n0 fail",
    }),
    parseTestOutput: () => ({ passed: 1, failed: 0, failures: [] }),
    testSummaryToFindings: () => [],
    resolveFullSuiteCommand: async () => undefined,
    ...overrides,
  };
}

/** Record every `regression()` call the op makes, and answer from `answers`. */
function recordingRegression(answers: readonly VerificationResult[]): {
  calls: VerificationGateOptions[];
  regression: NonNullable<VerifyScopedDeps["regression"]>;
} {
  const calls: VerificationGateOptions[] = [];
  return {
    calls,
    regression: async (opts) => {
      const answer = answers[calls.length] ?? answers.at(-1);
      calls.push(opts);
      if (answer === undefined) throw new Error("[test] no stub result left for this regression() call");
      return answer;
    },
  };
}

const SUCCESS_RUN: VerificationResult = {
  status: "SUCCESS",
  success: true,
  countsTowardEscalation: true,
  output: "3 passed",
};

const INTERRUPTED_RUN: VerificationResult = {
  status: "TIMEOUT",
  success: false,
  countsTowardEscalation: false,
  output: "stuck line",
  error: "EXECUTION_STALLED: Verification process made no progress",
  stopReason: STOP_REASON,
};

/** The scoped run the op must never mistake for a zero-test run: a code failure. */
const MIXED_LIST_RUN: VerificationResult = {
  status: "TEST_FAILURE",
  success: false,
  countsTowardEscalation: true,
  output: "1 test failed",
  exitCode: 1,
  stopReason: STOP_REASON,
};

const NO_TEST_PARSED = () => ({ passed: 0, failed: 0, failures: [] });

describe("verifyScopedOp — stall policy forwarding (US-004)", () => {
  // AC-9
  test("forwards the package-view stallDetection into the scoped regression run", async () => {
    const recorder = recordingRegression([SUCCESS_RUN]);

    const out = await verifyScopedOp.execute(
      INPUT,
      ctxWithQuality({ commands: { test: "bun test" }, stallDetection: PACKAGE_POLICY }),
      deps({ regression: recorder.regression }),
    );

    expect(out.status).toBe("passed");
    expect(recorder.calls).toHaveLength(1);
    // The run is the scoped command `selectScopedTests` returned, not the full suite.
    expect(recorder.calls[0]?.command).toBe(SCOPED_SELECTION.effectiveCommand);
    expect(recorder.calls[0]?.stallDetection).toEqual(PACKAGE_POLICY);
  });

  // AC-10
  test("forwards the same policy into the zero-tests full-suite rerun", async () => {
    const recorder = recordingRegression([
      { ...SUCCESS_RUN, output: "no tests" },
      { ...SUCCESS_RUN, output: "42 passed" },
    ]);

    const out = await verifyScopedOp.execute(
      INPUT,
      ctxWithQuality({ commands: { test: "bun test" }, stallDetection: PACKAGE_POLICY }),
      deps({
        regression: recorder.regression,
        parseTestOutput: (output) =>
          output === "no tests" ? NO_TEST_PARSED() : { passed: 42, failed: 0, failures: [] },
      }),
    );

    // The scoped run executed nothing, so the op reran the full suite — and both
    // runs, the scoped one and the rerun, carried the package policy.
    expect(recorder.calls).toHaveLength(2);
    expect(recorder.calls.map((call) => call.stallDetection)).toEqual([PACKAGE_POLICY, PACKAGE_POLICY]);
    expect(out.isFullSuite).toBe(true);
    expect(out.scopeTestFallback).toBe(true);
  });
});

describe("verifyScopedOp — interruption routing (US-004)", () => {
  // AC-11
  test("returns status timeout with the stopReason when the scoped run is interrupted", async () => {
    const recorder = recordingRegression([INTERRUPTED_RUN]);

    const out = await verifyScopedOp.execute(
      INPUT,
      ctxWithQuality({ commands: { test: "bun test" }, stallDetection: PACKAGE_POLICY }),
      deps({ regression: recorder.regression, parseTestOutput: NO_TEST_PARSED }),
    );

    expect(out.status).toBe("timeout");
    expect(out.success).toBe(false);
    expect(out.stopReason).toEqual(STOP_REASON);
    // A zero-test interrupted run is a timeout verdict, not a reason to rerun.
    expect(recorder.calls).toHaveLength(1);
  });

  // AC-12
  test("starts no zero-tests full-suite rerun when the aggregate carries a stop reason", async () => {
    // The aggregate status is an ordinary TEST_FAILURE and it parsed no tests, which
    // is exactly the shape that otherwise triggers the rerun.
    const recorder = recordingRegression([MIXED_LIST_RUN]);

    await verifyScopedOp.execute(
      INPUT,
      ctxWithQuality({ commands: { test: "bun test" }, stallDetection: PACKAGE_POLICY }),
      deps({ regression: recorder.regression, parseTestOutput: NO_TEST_PARSED }),
    );

    expect(recorder.calls).toHaveLength(1);
  });

  // A mixed list's ordinary failure must not be hidden behind the later stop:
  // the verdict stays a code failure with findings, and the reason rides along.
  test("keeps an ordinary failure in a mixed list as a code failure that carries the stop reason", async () => {
    const recorder = recordingRegression([MIXED_LIST_RUN]);

    const out: VerifyScopedOutput = await verifyScopedOp.execute(
      INPUT,
      ctxWithQuality({ commands: { test: "bun test" }, stallDetection: PACKAGE_POLICY }),
      deps({ regression: recorder.regression, parseTestOutput: NO_TEST_PARSED }),
    );

    expect(out.status).toBe("failed");
    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
    expect(out.stopReason).toEqual(STOP_REASON);
  });
});
