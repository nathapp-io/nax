import { describe, expect, test } from "bun:test";
import type { CompleteResult } from "@/agents/types";
import type { AdapterFailure } from "@/context/engine";

const staleFailure: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: true,
  message: "idle watchdog cancelled prompt — no stream activity for 30s",
};

const staleTerminal: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  retriable: false,
  message: "stale failure: retries exhausted",
};

describe("complete() with fail-stale failures", () => {
  test("returns CompleteResult with adapterFailure when stale timeout occurs", () => {
    const result: CompleteResult = {
      output: "", // Empty output when stale cancellation occurs
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      estimatedCostUsd: 0,
      adapterFailure: staleFailure,
    };

    expect(result.adapterFailure).toBeDefined();
    expect(result.adapterFailure?.outcome).toBe("fail-stale");
    expect(result.adapterFailure?.category).toBe("availability");
  });

  test("empty output field when fail-stale occurs (not passed to parser)", () => {
    const result: CompleteResult = {
      output: "", // Stale cancellation produces empty output
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      estimatedCostUsd: 0,
      adapterFailure: staleFailure,
    };

    // The stale failure should be in adapterFailure, not in output string
    expect(result.output).toBe("");
    expect(result.adapterFailure?.outcome).toBe("fail-stale");
  });

  test("fail-stale.retriable indicates whether same agent can be retried", () => {
    const retryable: CompleteResult = {
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      estimatedCostUsd: 0,
      adapterFailure: staleFailure,
    };
    expect(retryable.adapterFailure?.retriable).toBe(true);

    const terminal: CompleteResult = {
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      estimatedCostUsd: 0,
      adapterFailure: staleTerminal,
    };
    expect(terminal.adapterFailure?.retriable).toBe(false);
  });

  test("adapterFailure message distinguishes idle timeout from wall-clock timeout", () => {
    const idleTimeout: AdapterFailure = {
      category: "availability",
      outcome: "fail-stale",
      retriable: true,
      message: "idle watchdog: no stream activity for 30s, wall-clock time remaining",
    };

    const wallClockTimeout: AdapterFailure = {
      category: "quality",
      outcome: "fail-timeout",
      retriable: false,
      message: "wall-clock timeout exceeded (180s limit)",
    };

    expect(idleTimeout.outcome).toBe("fail-stale");
    expect(wallClockTimeout.outcome).toBe("fail-timeout");
  });
});
