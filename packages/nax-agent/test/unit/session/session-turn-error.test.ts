import { describe, expect, test } from "bun:test";
import type { AdapterFailure } from "#src/session/adapter-failure";
import { SessionTurnError } from "#src/session/session-types";

describe("SessionTurnError", () => {
  test("is a named Error carrying the message and the cancelled flag", () => {
    const err = new SessionTurnError("turn failed", true);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SessionTurnError");
    expect(err.message).toBe("turn failed");
    expect(err.cancelled).toBe(true);
  });

  test("defaults retryable to false and leaves every cost and failure field absent", () => {
    const err = new SessionTurnError("turn failed", false);

    expect(err.retryable).toBe(false);
    expect(err.tokenUsage).toBeUndefined();
    expect(err.estimatedCostUsd).toBeUndefined();
    expect(err.exactCostUsd).toBeUndefined();
    expect(err.pricingSource).toBeUndefined();
    expect(err.adapterFailure).toBeUndefined();
  });

  test("carries the spend of the failed turn and the typed failure unchanged", () => {
    const adapterFailure: AdapterFailure = {
      category: "availability",
      outcome: "fail-rate-limit",
      message: "slow down",
      retriable: true,
    };
    const err = new SessionTurnError(
      "rate limited",
      false,
      true,
      { inputTokens: 10, outputTokens: 2 },
      0.5,
      0.4,
      "catalog-rates",
      adapterFailure,
    );

    expect(err.retryable).toBe(true);
    expect(err.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(err.estimatedCostUsd).toBe(0.5);
    expect(err.exactCostUsd).toBe(0.4);
    expect(err.pricingSource).toBe("catalog-rates");
    expect(err.adapterFailure).toBe(adapterFailure);
  });
});
