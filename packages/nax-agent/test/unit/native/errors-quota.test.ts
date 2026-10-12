import { describe, expect, test } from "bun:test";
import { toAdapterFailure } from "@nathapp/nax-agent/internal";

describe("toAdapterFailure quota kind", () => {
  test("quota maps to a non-retriable fail-quota", () => {
    const failure = toAdapterFailure({ kind: "quota" });
    expect(failure.outcome).toBe("fail-quota");
    expect(failure.retriable).toBe(false);
    expect(failure.category).toBe("availability");
  });

  test("rate-limit still maps to a retriable fail-rate-limit", () => {
    const failure = toAdapterFailure({ kind: "rate-limit" });
    expect(failure.outcome).toBe("fail-rate-limit");
    expect(failure.retriable).toBe(true);
  });
});
