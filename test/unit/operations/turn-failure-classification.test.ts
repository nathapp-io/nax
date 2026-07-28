import { describe, expect, test } from "bun:test";
import type { TurnResult } from "@/agents";
import { classifyEmptyOutputFailure } from "@/operations";

function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    output: "",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    internalRoundTrips: 0,
    ...overrides,
  };
}

describe("classifyEmptyOutputFailure — AC4/AC5/AC6: timed out empty output", () => {
  test("maps empty output + timedOut=true to fail-timeout outcome", () => {
    const failure = classifyEmptyOutputFailure(makeTurnResult({ timedOut: true }));
    expect(failure).not.toBeNull();
    expect(failure?.outcome).toBe("fail-timeout");
  });

  test("maps empty output + timedOut=true to quality category", () => {
    const failure = classifyEmptyOutputFailure(makeTurnResult({ timedOut: true }));
    expect(failure?.category).toBe("quality");
  });

  test("maps empty output + timedOut=true to retriable=true", () => {
    const failure = classifyEmptyOutputFailure(makeTurnResult({ timedOut: true }));
    expect(failure?.retriable).toBe(true);
  });
});

describe("classifyEmptyOutputFailure — AC7/AC8: untimed empty output keeps fail-stale", () => {
  test("maps empty output with timedOut=false to fail-stale outcome", () => {
    const failure = classifyEmptyOutputFailure(makeTurnResult({ timedOut: false }));
    expect(failure?.outcome).toBe("fail-stale");
  });

  test("maps empty output with timedOut absent to fail-stale outcome", () => {
    const failure = classifyEmptyOutputFailure(makeTurnResult());
    expect(failure?.outcome).toBe("fail-stale");
  });

  test("maps empty output with timedOut false/absent to reason=empty-output", () => {
    expect(classifyEmptyOutputFailure(makeTurnResult({ timedOut: false }))?.reason).toBe("empty-output");
    expect(classifyEmptyOutputFailure(makeTurnResult())?.reason).toBe("empty-output");
  });
});

describe("classifyEmptyOutputFailure — AC9: existing adapterFailure is preserved", () => {
  test("preserves an existing adapterFailure when timedOut=true", () => {
    const existing = {
      category: "availability" as const,
      outcome: "fail-auth" as const,
      retriable: false,
      message: "auth missing",
    };
    const failure = classifyEmptyOutputFailure(makeTurnResult({ timedOut: true, adapterFailure: existing }));
    expect(failure).toEqual(existing);
  });

  test("preserves an existing adapterFailure when timedOut is absent", () => {
    const existing = {
      category: "availability" as const,
      outcome: "fail-rate-limit" as const,
      retriable: true,
      message: "rate limit hit",
    };
    const failure = classifyEmptyOutputFailure(makeTurnResult({ adapterFailure: existing }));
    expect(failure).toEqual(existing);
  });
});

describe("classifyEmptyOutputFailure — non-empty output", () => {
  test("returns null when output is non-empty and no adapterFailure is set", () => {
    const failure = classifyEmptyOutputFailure(makeTurnResult({ output: "non-empty content" }));
    expect(failure).toBeNull();
  });

  test("synthesises failure for whitespace-only output (preserves existing behavior)", () => {
    // Mirrors the original `!output?.trim()` check in sendWithFileOutput:
    // whitespace-only is treated as effectively empty for synthesis purposes.
    const failure = classifyEmptyOutputFailure(makeTurnResult({ output: "  " }));
    expect(failure?.outcome).toBe("fail-stale");
  });

  test("returns null when output is non-empty even if timedOut is true (timeout yields empty output)", () => {
    // Defensive: when output is non-empty the helper must not synthesise a failure.
    const failure = classifyEmptyOutputFailure(
      makeTurnResult({ output: "content", timedOut: true }),
    );
    expect(failure).toBeNull();
  });
});