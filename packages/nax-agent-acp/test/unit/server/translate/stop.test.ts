import { describe, expect, test } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import type { TurnEndStatus } from "@nathapp/nax-agent";
import { promptOutcome, type TurnEndEvent, toAcpUsage } from "#src/server/translate/stop";

const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 };

function end(status: TurnEndStatus, error?: { code: string; message: string }): TurnEndEvent {
  return {
    sessionId: "s",
    turnId: "t",
    at: "2026-10-08T00:00:00.000Z",
    metadata: {},
    type: "turn_end",
    status,
    output: "",
    usage: USAGE,
    costUsd: 0.02,
    ...(error !== undefined ? { error } : {}),
  };
}

describe("toAcpUsage", () => {
  test("maps every count and totals them", () => {
    expect(toAcpUsage(USAGE)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cachedReadTokens: 3,
      cachedWriteTokens: 2,
      totalTokens: 20,
    });
  });

  test("omits absent cache counts", () => {
    expect(toAcpUsage({ inputTokens: 1, outputTokens: 2 })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });
});

describe("promptOutcome (spec §4.4)", () => {
  test("completed -> end_turn, cancelled -> cancelled, no notices", () => {
    expect(promptOutcome(end("completed"), 60)).toEqual({
      kind: "response",
      response: { stopReason: "end_turn", usage: toAcpUsage(USAGE) },
      notices: [],
    });
    expect(promptOutcome(end("cancelled"), 60)).toMatchObject({
      kind: "response",
      response: { stopReason: "cancelled" },
    });
  });

  test("timed_out -> max_turn_requests with a warning naming the limit", () => {
    expect(promptOutcome(end("timed_out"), 3600)).toEqual({
      kind: "response",
      response: { stopReason: "max_turn_requests", usage: toAcpUsage(USAGE) },
      notices: [
        {
          sessionUpdate: "notice",
          severity: "warning",
          title: "Turn timed out",
          description: "The turn reached its 3600s time limit and was stopped.",
        },
      ],
    });
  });

  test("errored -> internal error carrying the turn's code and message", () => {
    const outcome = promptOutcome(end("errored", { code: "PROVIDER_FAILED", message: "upstream 500" }), 60);
    expect(outcome.kind).toBe("error");
    const error = outcome.kind === "error" ? outcome.error : undefined;
    expect(error).toBeInstanceOf(RequestError);
    expect(error?.code).toBe(-32603);
    expect(error?.data).toEqual({ code: "PROVIDER_FAILED", message: "upstream 500" });
  });

  test("errored without detail and interrupted still produce an internal error", () => {
    const noDetail = promptOutcome(end("errored"), 60);
    expect(noDetail.kind === "error" ? noDetail.error.data : undefined).toEqual({
      code: "AGENT_TURN_ERRORED",
      message: "The turn failed",
    });
    const interrupted = promptOutcome(end("interrupted"), 60);
    expect(interrupted.kind === "error" ? interrupted.error.data : undefined).toEqual({
      code: "AGENT_TURN_INTERRUPTED",
      message: "The turn was interrupted",
    });
  });
});
