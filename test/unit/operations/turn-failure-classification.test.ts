import { describe, expect, test } from "bun:test";
import type { TurnResult } from "@/agents";
import { classifyEmptyOutputFailure, classifyProviderRefusalFailure } from "@/operations";

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

  test("classifies as fail-timeout when output is non-empty but timedOut is true", () => {
    // Transport facts outrank output emptiness: a truncated turn usually HAS
    // prose, so `timedOut` must classify as a failure even with content present.
    const failure = classifyEmptyOutputFailure(makeTurnResult({ output: "content", timedOut: true }));
    expect(failure?.outcome).toBe("fail-timeout");
  });
});

describe("classifyEmptyOutputFailure — transport facts outrank non-empty output", () => {
  test("a timed-out turn WITH prose is a failure, not a success", () => {
    const failure = classifyEmptyOutputFailure(
      makeTurnResult({
        output: "All green. Let me verify the final state of the file:",
        internalRoundTrips: 4,
        timedOut: true,
      }),
    );
    expect(failure).not.toBeNull();
    expect(failure?.outcome).toBe("fail-timeout");
    expect(failure?.reason).toBe("wall-clock-timeout");
  });

  test("an incomplete turn WITH prose classifies as quality, never fail-stale", () => {
    const failure = classifyEmptyOutputFailure(
      makeTurnResult({ output: "still working on it", internalRoundTrips: 10, turnIncomplete: true }),
    );
    expect(failure?.category).toBe("quality");
    expect(failure?.outcome).toBe("fail-quality");
    expect(failure?.reason).toBe("turn-incomplete");
  });

  test("a complete turn with output is still a success", () => {
    const failure = classifyEmptyOutputFailure(makeTurnResult({ output: "done", internalRoundTrips: 2 }));
    expect(failure).toBeNull();
  });

  test("an existing adapterFailure still wins over both facts", () => {
    const existing = { category: "availability", outcome: "fail-quota", retriable: true, message: "m" } as const;
    const failure = classifyEmptyOutputFailure(
      makeTurnResult({ output: "text", timedOut: true, adapterFailure: existing }),
    );
    expect(failure).toBe(existing);
  });
});

describe("classifyProviderRefusalFailure (BUG-62)", () => {
  test("classifies the measured capacity-refusal literal as a retriable availability failure", () => {
    const failure = classifyProviderRefusalFailure("Selected model is at capacity. Please try a different model.");
    expect(failure).toEqual({
      category: "availability",
      outcome: "fail-rate-limit",
      retriable: true,
      message: "Selected model is at capacity. Please try a different model.",
    });
  });

  test("matches case-insensitively and trims surrounding whitespace", () => {
    const failure = classifyProviderRefusalFailure("  Selected model is at capacity right now  ");
    expect(failure).not.toBeNull();
    expect(failure?.outcome).toBe("fail-rate-limit");
    expect(failure?.message).toBe("Selected model is at capacity right now");
  });

  test("returns null for empty or whitespace-only output", () => {
    expect(classifyProviderRefusalFailure("")).toBeNull();
    expect(classifyProviderRefusalFailure("   ")).toBeNull();
  });

  test("returns null when the phrase appears mid-output rather than at the start", () => {
    // A refusal is the whole message; prose that merely mentions the phrase later
    // (e.g. an implementer's summary, or a reviewer discussing it) must not match.
    expect(
      classifyProviderRefusalFailure(
        "I checked the retry handling and confirmed selected model is at capacity errors are now handled.",
      ),
    ).toBeNull();
  });

  test("returns null for a genuine review verdict, even one that quotes the phrase as finding evidence", () => {
    const verdict = JSON.stringify({
      passed: false,
      findings: [{ message: "Missing test for the 'Selected model is at capacity' refusal path" }],
    });
    expect(classifyProviderRefusalFailure(verdict)).toBeNull();
  });

  test("returns null for any output over the length cap, even if it starts with the literal", () => {
    const long = `Selected model is at capacity. ${"x".repeat(400)}`;
    expect(classifyProviderRefusalFailure(long)).toBeNull();
  });

  test("returns null for unparseable prose that isn't a provider refusal", () => {
    expect(classifyProviderRefusalFailure("I reviewed the diff but couldn't reach a conclusion.")).toBeNull();
  });
});
