import { describe, expect, it, vi } from "vitest";
import { classifyProviderError } from "../../src/protocols/errors.ts";
import { createPiProtocol, type PiDeps, type PiResponse } from "../../src/protocols/pi-client.ts";
import { retryTransportFaults } from "../../src/protocols/retry.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";

const PAYMENT =
  '402 {"type":"error","error":{"type":"insufficient_balance_error","message":"insufficient balance (1008)"}}';
const REQUEST: ProtocolRequest = { model: "test", messages: [{ role: "user", content: "hi" }] };

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const result: ProtocolEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function fakeProtocol(message: string, response?: PiResponse) {
  const deps: PiDeps = {
    resolveModel: async () => ({
      id: "test",
      name: "Test",
      api: "openai-completions",
      provider: "test",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    }),
    stream: vi.fn<PiDeps["stream"]>(async function* (_model, _context, _options, onResponse) {
      if (response !== undefined) onResponse(response);
      yield {
        type: "error",
        reason: "error",
        error: {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "test",
          model: "test",
          stopReason: "error",
          timestamp: 0,
          errorMessage: message,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      } as const;
    }),
  };
  return { protocol: createPiProtocol("test", deps), deps };
}

describe("createPiProtocol SDK error status recovery", () => {
  it.each([
    [PAYMENT, "quota", 402],
    ["Provider is not configured: strata", "auth", undefined],
    ['401: {"type":"authentication_error","message":"missing or wrong API key"}', "auth", 401],
    ['429: {"error":{"message":"slow down"}}', "rate-limit", 429],
    ['429 {"error":{"message":"slow down"}}', "rate-limit", 429],
    ["500 tokens were generated", "transport", undefined],
    ["429 status code (no body)", "rate-limit", 429],
    ['503 {"error":{}}', "overloaded", 503],
    ['408 {"error":{}}', "bad-request", 408],
    ['409 {"error":{}}', "bad-request", 409],
    ["401 Unauthorized", "transport", undefined],
  ] as const)("classifies %s as %s with status %s", async (message, kind, status) => {
    const { protocol } = fakeProtocol(message);
    const events = await collect(protocol.stream(REQUEST));
    expect(events).toEqual([
      {
        type: "error",
        error: {
          kind,
          message,
          ...(status !== undefined ? { status } : {}),
        },
      },
    ]);
    if (status === undefined && events[0]?.type === "error") {
      expect(events[0].error).not.toHaveProperty("status");
    }
  });

  it("keeps the observed 200 and retry-after over the SDK status", async () => {
    const { protocol } = fakeProtocol(PAYMENT, { status: 200, headers: { "retry-after": "12" } });
    expect(await collect(protocol.stream(REQUEST))).toEqual([
      {
        type: "error",
        error: {
          kind: classifyProviderError(200, PAYMENT),
          message: PAYMENT,
          status: 200,
          retryAfter: 12,
        },
      },
    ]);
  });

  it("does not retry a recovered 402 before content", async () => {
    const { protocol, deps } = fakeProtocol(PAYMENT);
    const sleep = vi.fn(async () => {});
    const events = await collect(retryTransportFaults(() => protocol.stream(REQUEST), { retries: 2, sleep }));
    expect(events).toEqual([{ type: "error", error: { kind: "quota", message: PAYMENT, status: 402 } }]);
    expect(deps.stream).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
