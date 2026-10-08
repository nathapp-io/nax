// test/unit/agents/acp/prompt-retry.test.ts
import { describe, expect, test } from "bun:test";
import { AgentSessionError, NaxError } from "@nathapp/nax-agent";
import { isRetryablePromptError, promptRetryDelayMs } from "@/agents/acp/prompt-retry";

describe("isRetryablePromptError (S4b-0 Ruling T1-1, acpx 0.19.4)", () => {
  test.each([
    ["TURN_FAILED -32603", new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }), true],
    ["TURN_FAILED -32700", new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32700 }), true],
    ["rate limited (a -32603)", new AgentSessionError("slow", "AGENT_SESSION_RATE_LIMITED"), true],
    ["TURN_FAILED -32600", new NaxError("x", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32600 }), false],
    ["TURN_FAILED no rpcCode", new NaxError("x", "AGENT_SESSION_TURN_FAILED", {}), false],
    ["session gone -32603", new NaxError("Session not found", "AGENT_SESSION_TURN_FAILED", { rpcCode: -32603 }), false],
    ["auth", new AgentSessionError("login", "AGENT_SESSION_AUTH_REQUIRED"), false],
    ["backend gone", new AgentSessionError("x", "AGENT_SESSION_BACKEND_UNAVAILABLE"), false],
    ["stop reason", new NaxError("t", "ACP_STOP_MAX_TOKENS"), false],
    ["plain Error", new Error("-32603"), false],
  ])("%s -> %p", (_name, err, retryable) => {
    expect(isRetryablePromptError(err)).toBe(retryable);
  });
});

describe("promptRetryDelayMs: min(1000 * 2^n, 10000), no jitter", () => {
  test.each([
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [3, 8_000],
    [4, 10_000],
    [9, 10_000],
  ])("retry %d waits %d ms", (index, ms) => {
    expect(promptRetryDelayMs(index)).toBe(ms);
  });
});
