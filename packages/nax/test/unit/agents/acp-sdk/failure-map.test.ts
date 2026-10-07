import { describe, expect, test } from "bun:test";
import { AgentSessionError, NaxError, SessionTurnError } from "@nathapp/nax-agent";
import {
  classifyTurnFailure,
  isSessionGone,
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

  test("no abort and no code: fail-unknown carrying the error's message (D3-e)", () => {
    const failure = classifyTurnFailure(new Error("agent exploded"), undefined);
    expect(failure).toMatchObject({ message: "agent exploded", cancelled: false, retryable: false });
    expect(failure.adapterFailure).toMatchObject({ outcome: "fail-unknown", category: "quality" });
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

describe("classifyTurnFailure: the §7.1 code rows (S4b-3)", () => {
  const rows: Array<[string, Error, string, "availability" | "quality", boolean]> = [
    ["auth", new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED"), "fail-auth", "availability", false],
    [
      "rate limit",
      new AgentSessionError("slow", "AGENT_SESSION_RATE_LIMITED"),
      "fail-rate-limit",
      "availability",
      true,
    ],
    [
      "model not offered",
      new AgentSessionError("m", "AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "model" }),
      "fail-adapter-error",
      "quality",
      false,
    ],
    [
      "profile on codex",
      new AgentSessionError("p", "AGENT_SESSION_CAPABILITY_UNSUPPORTED", { capability: "profile" }),
      "fail-adapter-error",
      "quality",
      false,
    ],
    [
      "backend gone",
      new AgentSessionError("x", "AGENT_SESSION_BACKEND_UNAVAILABLE"),
      "fail-adapter-error",
      "availability",
      false,
    ],
    ["agent cancelled", new NaxError("c", "ACP_STOP_CANCELLED"), "fail-adapter-error", "quality", false],
    ["max tokens", new NaxError("t", "ACP_STOP_MAX_TOKENS"), "fail-incomplete", "quality", false],
    ["max turn requests", new NaxError("t", "ACP_STOP_MAX_TURN_REQUESTS"), "fail-incomplete", "quality", false],
    ["refusal", new NaxError("r", "ACP_STOP_REFUSAL"), "fail-quality", "quality", false],
    [
      "turn failed",
      new NaxError("f", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }),
      "fail-adapter-error",
      "availability",
      false,
    ],
    [
      "closed after reconnect",
      new AgentSessionError("c", "AGENT_SESSION_CLOSED"),
      "fail-adapter-error",
      "availability",
      false,
    ],
    [
      "not found after recovery",
      new AgentSessionError("n", "AGENT_SESSION_NOT_FOUND"),
      "fail-adapter-error",
      "availability",
      false,
    ],
    ["unknown code", new NaxError("u", "SOMETHING_ELSE"), "fail-unknown", "quality", false],
    ["plain Error (D3-e)", new Error("boom"), "fail-unknown", "quality", false],
  ];

  test.each(rows)("%s", (_name, err, outcome, category, retryable) => {
    const failure = classifyTurnFailure(err, undefined);
    expect(failure.adapterFailure).toMatchObject({ outcome, category, retriable: retryable });
    expect(failure).toMatchObject({ cancelled: false, retryable });
  });

  test("a rate limit carries retryAfterSeconds when the backend gave one", () => {
    const err = new AgentSessionError("slow", "AGENT_SESSION_RATE_LIMITED", { retryAfterSeconds: 42 });
    expect(classifyTurnFailure(err, undefined).adapterFailure.retryAfterSeconds).toBe(42);
  });

  test("a rate limit without one has no retryAfterSeconds", () => {
    const err = new AgentSessionError("slow", "AGENT_SESSION_RATE_LIMITED");
    expect("retryAfterSeconds" in classifyTurnFailure(err, undefined).adapterFailure).toBe(false);
  });

  test("an abort cause still wins over the error's code", () => {
    const err = new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED");
    expect(classifyTurnFailure(err, new RunAborted()).adapterFailure.outcome).toBe("fail-aborted");
  });
});

describe("isSessionGone (D3-f)", () => {
  test.each([
    ["NOT_FOUND", new AgentSessionError("gone", "AGENT_SESSION_NOT_FOUND"), true],
    ["TURN_FAILED -32002", new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32002 }), true],
    [
      "TURN_FAILED text",
      new NaxError("The ACP prompt failed: Session not found", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }),
      true,
    ],
    [
      "TURN_FAILED no conversation",
      new NaxError("No conversation found with id", "AGENT_SESSION_TURN_FAILED", {}),
      true,
    ],
    [
      "TURN_FAILED other",
      new NaxError("The ACP prompt failed: boom", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }),
      false,
    ],
    ["CLOSED", new AgentSessionError("closed", "AGENT_SESSION_CLOSED"), false],
    ["plain Error", new Error("session not found"), false],
  ])("%s -> %p", (_name, err, gone) => {
    expect(isSessionGone(err)).toBe(gone);
  });
});
