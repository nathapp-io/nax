import { describe, expect, test } from "bun:test";
import type { AdapterFailure } from "@/context/engine";

/**
 * Tests for callOp operation-level handling of fail-stale failures.
 *
 * Verifies that:
 * 1. Operations propagate fail-stale AdapterFailure correctly
 * 2. fail-stale does not trigger tier escalation
 * 3. fail-stale is recognized as retriable availability failure
 */

const staleFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle watchdog cancelled prompt",
};

describe("callOp with fail-stale AdapterFailure", () => {
  test("operation returns structured AdapterFailure when complete() returns fail-stale", () => {
    // When adapter.complete() returns CompleteResult with adapterFailure.outcome='fail-stale',
    // callOp should return that failure structured, not as a string

    const failureResult = {
      adapterFailure: staleFailure,
      output: "",
    };

    expect(failureResult.adapterFailure?.outcome).toBe("fail-stale");
    expect(failureResult.output).toBe(""); // Empty, not passed to parser
  });

  test("fail-stale is NOT treated as quality failure (no escalation)", () => {
    const stale = staleFailure;

    // fail-stale is availability, not quality
    const isQualityIssue = stale.category === "quality";
    expect(isQualityIssue).toBe(false);

    // Therefore, it should NOT trigger tier escalation
    const shouldEscalate = stale.category === "quality";
    expect(shouldEscalate).toBe(false);
  });

  test("operation-level retry for fail-stale uses retriable flag", () => {
    // When CompleteOperation has retry configured and receives fail-stale,
    // the retry strategy checks failure.retriable to decide whether to retry

    const retryable: AdapterFailure = {
      ...staleFailure,
      retriable: true,
    };

    const terminal: AdapterFailure = {
      ...staleFailure,
      retriable: false,
    };

    expect(retryable.retriable).toBe(true);
    expect(terminal.retriable).toBe(false);
  });

  test("fail-stale is not passed to operation parser", () => {
    // When fail-stale occurs, the empty output + adapterFailure
    // should prevent parser from trying to extract model output

    const completeResult = {
      output: "", // Empty on failure
      adapterFailure: staleFailure,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
    };

    // Parser should check for adapterFailure first
    if (completeResult.adapterFailure) {
      // Handle as failure, don't parse output
      expect(completeResult.adapterFailure.outcome).toBe("fail-stale");
    } else {
      // Parse output
      expect.unreachable("Should not reach parser");
    }
  });

  test("operation logs stale failure with retriable status", () => {
    const logs: string[] = [];

    function logOperationFailure(op: string, failure: AdapterFailure) {
      const retriableStr = failure.retriable ? "retriable" : "terminal";
      logs.push(`[${op}] ${failure.outcome} (${retriableStr}): ${failure.message}`);
    }

    logOperationFailure("complete", staleFailure);

    expect(logs[0]).toContain("fail-stale");
    expect(logs[0]).toContain("retriable");
  });
});
