import { describe, expect, test } from "bun:test";
import { aggregateResults } from "@/quality/aggregate";
import type { QualityCommandResult } from "@/quality/runner";

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
