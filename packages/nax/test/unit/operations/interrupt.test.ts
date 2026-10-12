import { describe, expect, test } from "bun:test";
import { SessionFailureError } from "@/agents";
import type { AdapterFailure } from "@/context/engine";
import { isInterruptedStale } from "@/operations/_interrupt";

function staleFailure(reason: string): AdapterFailure {
  return { category: "availability", outcome: "fail-stale", message: "x", retriable: true, reason };
}

describe("isInterruptedStale", () => {
  test("true only for fail-stale with reason interrupted", () => {
    const interrupted = new SessionFailureError("x", staleFailure("interrupted"));
    const stalled = new SessionFailureError("x", staleFailure("idle"));
    expect(isInterruptedStale(interrupted)).toBe(true);
    expect(isInterruptedStale(stalled)).toBe(false);
    expect(isInterruptedStale(new Error("x"))).toBe(false);
  });
});
