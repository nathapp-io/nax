import { describe, expect, test } from "bun:test";
import { aggregateResults } from "@/quality/aggregate";
import type { QualityCommandResult } from "@/quality/runner";
import type { GateStopReason } from "@/utils/gate-stall";

function result(over: Partial<QualityCommandResult>): QualityCommandResult {
  return {
    commandName: "typecheck",
    command: "tsc --noEmit",
    success: true,
    exitCode: 0,
    output: "",
    durationMs: 10,
    timedOut: false,
    ...over,
  };
}

const repeatedOnStdout: GateStopReason = { kind: "repeated-output", stream: "stdout", count: 2, threshold: 2 };
const silent: GateStopReason = { kind: "silence", silenceTimeoutSeconds: 5 };

/**
 * An entry a detector stopped: the runner's stopped shape (`success` false,
 * exit -1, timedOut) carrying its reason.
 */
function stopped(reason: GateStopReason, over: Partial<QualityCommandResult> = {}): QualityCommandResult {
  return result({ success: false, exitCode: -1, timedOut: true, stopReason: reason, ...over });
}

describe("aggregateResults", () => {
  test("succeeds only when every step succeeded", () => {
    const agg = aggregateResults("typecheck", [result({}), result({ command: "tsc -p b" })]);
    expect(agg.success).toBe(true);
    expect(agg.exitCode).toBe(0);
  });

  test("fails when any step failed", () => {
    const agg = aggregateResults("typecheck", [
      result({}),
      result({ command: "tsc -p b", success: false, exitCode: 2 }),
    ]);
    expect(agg.success).toBe(false);
  });

  test("reports the first non-zero exit code", () => {
    const agg = aggregateResults("typecheck", [
      result({ success: false, exitCode: 2 }),
      result({ command: "tsc -p b", success: false, exitCode: 5 }),
    ]);
    expect(agg.exitCode).toBe(2);
  });

  test("includes output from every step, failing and passing alike", () => {
    const agg = aggregateResults("typecheck", [
      result({ command: "tsc --noEmit", success: false, exitCode: 2, output: "src error" }),
      result({ command: "tsc -p tsconfig.test.json", output: "clean" }),
    ]);
    expect(agg.output).toContain("src error");
    expect(agg.output).toContain("clean");
    expect(agg.output).toContain("=== tsc --noEmit (exit 2) ===");
    expect(agg.output).toContain("=== tsc -p tsconfig.test.json (exit 0) ===");
  });

  test("does not stop at the first failure — later output is present", () => {
    const agg = aggregateResults("lint", [
      result({ command: "a", success: false, exitCode: 1, output: "first failure" }),
      result({ command: "b", success: false, exitCode: 1, output: "second failure" }),
    ]);
    expect(agg.output).toContain("first failure");
    expect(agg.output).toContain("second failure");
  });

  test("sums durations", () => {
    const agg = aggregateResults("typecheck", [result({ durationMs: 10 }), result({ durationMs: 32 })]);
    expect(agg.durationMs).toBe(42);
  });

  test("is timedOut when any step timed out", () => {
    const agg = aggregateResults("test", [result({}), result({ timedOut: true, success: false, exitCode: -1 })]);
    expect(agg.timedOut).toBe(true);
  });

  test("joins commands for display", () => {
    const agg = aggregateResults("typecheck", [result({ command: "a" }), result({ command: "b" })]);
    expect(agg.command).toBe("a && b");
  });

  test("preserves the command name", () => {
    expect(aggregateResults("lint", [result({})]).commandName).toBe("lint");
  });
});

// ---------------------------------------------------------------------------
// US-006 — the aggregate carries interruption evidence independently
// ---------------------------------------------------------------------------

describe("aggregateResults — first detector reason (AC-3)", () => {
  test("AC-3: exposes the first stopped entry's reason in command order", () => {
    const agg = aggregateResults("test", [
      result({}),
      stopped(repeatedOnStdout, { command: "b" }),
      stopped(silent, { command: "c" }),
    ]);
    expect(agg.stopReason).toEqual(repeatedOnStdout);
  });

  test("AC-3: a stop after an ordinary failure is still the reason, not the failure", () => {
    const agg = aggregateResults("test", [
      result({ command: "a", success: false, exitCode: 2 }),
      stopped(silent, { command: "b" }),
    ]);
    expect(agg.stopReason).toEqual(silent);
    // The exit code stays the ordinary failure's — the two carriers are independent.
    expect(agg.exitCode).toBe(2);
  });

  test("AC-3: has no stopReason key when no entry was stopped", () => {
    const agg = aggregateResults("test", [
      result({}),
      result({ command: "b", success: false, exitCode: -1, timedOut: true }),
    ]);
    expect("stopReason" in agg).toBe(false);
  });
});

describe("aggregateResults — first non-zero exit (AC-4)", () => {
  test("AC-4: keeps the first ordinary non-zero exit when a later entry was stopped", () => {
    const agg = aggregateResults("test", [
      result({ command: "a", success: false, exitCode: 2 }),
      stopped(repeatedOnStdout, { command: "b" }),
    ]);
    expect(agg.exitCode).toBe(2);
    expect(agg.success).toBe(false);
  });

  test("AC-4: a stopped first entry's -1 is the first non-zero exit", () => {
    const agg = aggregateResults("test", [
      stopped(silent, { command: "a" }),
      result({ command: "b", success: false, exitCode: 5 }),
    ]);
    expect(agg.exitCode).toBe(-1);
  });
});

describe("aggregateResults — any-entry timeout (AC-5)", () => {
  test("AC-5: is timedOut when a later entry timed out behind an ordinary first failure", () => {
    const agg = aggregateResults("test", [
      result({ command: "a", success: false, exitCode: 2 }),
      result({ command: "b", success: false, exitCode: -1, timedOut: true }),
    ]);
    expect(agg.exitCode).toBe(2);
    expect(agg.timedOut).toBe(true);
  });

  test("AC-5: a detector-stopped entry makes the aggregate timedOut", () => {
    const agg = aggregateResults("test", [result({ command: "a" }), stopped(repeatedOnStdout, { command: "b" })]);
    expect(agg.timedOut).toBe(true);
    expect(agg.exitCode).toBe(-1);
  });
});

describe("aggregateResults — summed duration (AC-6)", () => {
  test("AC-6: sums every entry's duration, the stopped one included", () => {
    const agg = aggregateResults("test", [
      result({ command: "a", durationMs: 10 }),
      stopped(repeatedOnStdout, { command: "b", durationMs: 32 }),
      result({ command: "c", durationMs: 5 }),
    ]);
    expect(agg.durationMs).toBe(47);
  });
});

describe("aggregateResults — combined output (AC-7)", () => {
  test("AC-7: keeps the output of every entry, the stopped one included", () => {
    const agg = aggregateResults("test", [
      result({ command: "a", success: false, exitCode: 2, output: "first diagnostics" }),
      stopped(repeatedOnStdout, { command: "b", output: "[nax] test stopped early: repeated-output on stdout" }),
      result({ command: "c", output: "third clean" }),
    ]);
    expect(agg.output).toContain("first diagnostics");
    expect(agg.output).toContain("[nax] test stopped early: repeated-output on stdout");
    expect(agg.output).toContain("third clean");
    expect(agg.output).toContain("=== b (exit -1) ===");
  });
});
