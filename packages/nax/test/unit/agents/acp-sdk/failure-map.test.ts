import { describe, expect, test } from "bun:test";
import { SessionTurnError } from "@nathapp/nax-agent";
import {
  classifyTurnFailure,
  RunAborted,
  TurnDeadlineExpired,
  turnFailureError,
  WatchdogCancel,
} from "@/agents/acp-sdk/failure-map";
import { FALLBACK_RATES } from "@/agents/cost";

const CARD = { rates: FALLBACK_RATES, source: "fallback-rates" } as const;

describe("classifyTurnFailure (S4b spec §7.1, cancel rows)", () => {
  test("a watchdog cancel is fail-stale, cancelled and retryable", () => {
    const failure = classifyTurnFailure(new WatchdogCancel(), new WatchdogCancel());
    expect(failure).toMatchObject({ cancelled: true, retryable: true });
    expect(failure.adapterFailure).toMatchObject({ outcome: "fail-stale", retriable: true, reason: "idle-watchdog" });
  });

  test("a run abort is fail-aborted, cancelled, not retryable", () => {
    const failure = classifyTurnFailure(new RunAborted("shutdown"), new RunAborted("shutdown"));
    expect(failure).toMatchObject({ cancelled: true, retryable: false });
    expect(failure.adapterFailure.outcome).toBe("fail-aborted");
  });

  test("an abort with an unknown reason fails safe as fail-aborted", () => {
    expect(classifyTurnFailure(new Error("x"), new DOMException("aborted")).adapterFailure.outcome).toBe(
      "fail-aborted",
    );
  });

  test("no abort: fail-adapter-error carrying the error's message, as acpx today (S4b-3 adds the code rows)", () => {
    const failure = classifyTurnFailure(new Error("agent exploded"), undefined);
    expect(failure).toMatchObject({ cancelled: false, retryable: false, message: "agent exploded" });
    expect(failure.adapterFailure).toMatchObject({
      category: "availability",
      outcome: "fail-adapter-error",
      retriable: false,
    });
  });

  test("the message is capped at 500 characters", () => {
    expect(classifyTurnFailure(new Error("x".repeat(900)), undefined).message).toHaveLength(500);
  });

  test("each reason class is a distinct Error", () => {
    expect(new TurnDeadlineExpired()).toBeInstanceOf(Error);
    expect(new WatchdogCancel()).not.toBe(new WatchdogCancel());
  });
});

describe("turnFailureError", () => {
  test("builds a SessionTurnError with the spend and the adapter failure", () => {
    const failure = classifyTurnFailure(new WatchdogCancel(), new WatchdogCancel());
    const err = turnFailureError(
      failure,
      { tokenUsage: { inputTokens: 10, outputTokens: 0 }, exactCostUsd: 0.5 },
      CARD,
    );
    expect(err).toBeInstanceOf(SessionTurnError);
    expect(err.cancelled).toBe(true);
    expect(err.retryable).toBe(true);
    expect(err.tokenUsage).toEqual({ inputTokens: 10, outputTokens: 0 });
    expect(err.exactCostUsd).toBe(0.5);
    expect(err.pricingSource).toBe("fallback-rates");
    expect(err.adapterFailure?.outcome).toBe("fail-stale");
  });
});
