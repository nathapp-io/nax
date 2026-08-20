import { describe, expect, test } from "bun:test";
import { SessionFailureError } from "@/agents/types";
import type { AdapterFailure } from "@/context/engine";

const staleFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle watchdog cancelled session due to no stream activity",
};

const staleTerminal: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: false,
  message: "stale session failures exhausted retries",
};

describe("SessionFailureError with fail-stale", () => {
  test("carries fail-stale AdapterFailure for sendTurn() failures", () => {
    const error = new SessionFailureError("stale prompt cancelled", staleFailure);
    expect(error.adapterFailure).toBeDefined();
    expect(error.adapterFailure.outcome).toBe("fail-stale");
    expect(error.adapterFailure.category).toBe("availability");
    expect(error.adapterFailure.retriable).toBe(true);
  });

  test("carries terminal fail-stale AdapterFailure when retries exhausted", () => {
    const error = new SessionFailureError("stale failures exhausted", staleTerminal);
    expect(error.adapterFailure.outcome).toBe("fail-stale");
    expect(error.adapterFailure.retriable).toBe(false);
  });

  test("preserves stale failure details through error propagation", () => {
    const failure: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: "idle for 30 seconds without stream data",
      retryAfterSeconds: 5,
    };
    const error = new SessionFailureError("session stalled", failure);
    expect(error.adapterFailure.message).toContain("idle");
    expect(error.adapterFailure.retryAfterSeconds).toBe(5);
  });

  test("is instanceof Error for standard error handling", () => {
    const error = new SessionFailureError("stale prompt", staleFailure);
    expect(error instanceof Error).toBe(true);
    expect(error instanceof SessionFailureError).toBe(true);
  });

  test("error message includes human-readable description", () => {
    const error = new SessionFailureError("idle watchdog triggered stale cancellation", staleFailure);
    expect(error.message).toContain("idle watchdog");
  });

  test("adapterFailure is accessible for manager-level fallback decisions", () => {
    const error = new SessionFailureError("stale", staleFailure);
    // AgentManager catch block would do:
    if (error instanceof SessionFailureError) {
      const failure = error.adapterFailure;
      const shouldFallback = failure.category === "availability";
      expect(shouldFallback).toBe(true);
    }
  });
});
