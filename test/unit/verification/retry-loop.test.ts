import { describe, expect, mock, test } from "bun:test";
import {
  type RetryAttempt,
  type RetryInput,
  type RetryOutcome,
  type VerifyOutcome,
  runRetryLoop,
} from "../../../src/verification/shared-rectification-loop";

type TestFailure = { message: string };
type TestResult = { output: string };

function makeInput(
  overrides: Partial<RetryInput<TestFailure, TestResult>> = {},
): RetryInput<TestFailure, TestResult> {
  return {
    stage: "run",
    storyId: "US-001",
    packageDir: "/tmp/pkg",
    maxAttempts: 3,
    failure: { message: "test failed" },
    previousAttempts: [],
    buildPrompt: (_failure, _prev) => "fix this",
    execute: async (_prompt) => ({ output: "fixed" }),
    verify: async (_result) => ({ passed: true }),
    ...overrides,
  };
}

describe("runRetryLoop", () => {
  test("returns fixed outcome when verify passes on first attempt", async () => {
    const input = makeInput();
    const outcome = await runRetryLoop(input);
    expect(outcome.outcome).toBe("fixed");
    if (outcome.outcome === "fixed") {
      expect(outcome.result).toEqual({ output: "fixed" });
      expect(outcome.attempts).toBe(1);
    }
  });

  test("returns exhausted outcome when verify never passes", async () => {
    const input = makeInput({
      maxAttempts: 2,
      verify: async (_result) => ({ passed: false, newFailure: { message: "still failing" } }),
    });
    const outcome = await runRetryLoop(input);
    expect(outcome.outcome).toBe("exhausted");
    if (outcome.outcome === "exhausted") {
      expect(outcome.attempts).toBe(2);
    }
  });

  test("passes accumulated previousAttempts to buildPrompt", async () => {
    const calls: Array<[TestFailure, readonly RetryAttempt<TestResult>[]]> = [];
    const buildPrompt = mock((_failure: TestFailure, prev: readonly RetryAttempt<TestResult>[]) => {
      calls.push([_failure, [...prev]]);
      return `attempt ${prev.length + 1}`;
    });
    let callCount = 0;
    const input = makeInput({
      maxAttempts: 3,
      buildPrompt,
      verify: async (_result) => {
        callCount++;
        if (callCount >= 2) return { passed: true };
        return { passed: false, newFailure: { message: "still failing" } };
      },
    });
    await runRetryLoop(input);
    // buildPrompt called at least twice
    expect(buildPrompt).toHaveBeenCalledTimes(2);
    // On first call, previousAttempts should be empty (it's passed as [...previousAttempts] which is empty by default)
    expect(calls[0][1].length).toBe(0);
    // On second call, previousAttempts should have 1 item from the first attempt
    expect(calls[1][1].length).toBe(1);
  });

  test("updates failure for subsequent attempts from VerifyOutcome.newFailure", async () => {
    const failures: TestFailure[] = [];
    let attemptCount = 0;
    const input = makeInput({
      maxAttempts: 3,
      verify: async (_result) => {
        attemptCount++;
        if (attemptCount === 1) {
          return { passed: false, newFailure: { message: "updated failure" } };
        }
        return { passed: true };
      },
      buildPrompt: (failure, _prev) => {
        failures.push(failure);
        return "fix";
      },
    });
    await runRetryLoop(input);
    expect(failures).toHaveLength(2);
    expect(failures[0]).toEqual({ message: "test failed" }); // first attempt uses initial failure
    expect(failures[1]).toEqual({ message: "updated failure" }); // second uses updated
  });
});
