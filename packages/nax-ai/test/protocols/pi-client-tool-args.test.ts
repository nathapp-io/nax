import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPiProtocol } from "../../src/protocols/pi-client.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";

const MODEL: Model<Api> = {
  id: "deepseek-chat",
  name: "DeepSeek Chat",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 64000,
  maxTokens: 8000,
};

const BASE: ProtocolRequest = { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] };

function fakePi(events: AssistantMessageEvent[]) {
  return {
    resolveModel: async () => MODEL,
    stream: (_model: Model<Api>, _context: Context, _options: SimpleStreamOptions, _onResponse: unknown) =>
      (async function* () {
        for (const event of events) yield event;
      })(),
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-completions" as Api,
    provider: "deepseek",
    model: "deepseek-chat",
    usage: {
      input: 10,
      output: 4,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 17,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: 0,
    ...overrides,
  };
}

function withCall() {
  return message({ content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] });
}

function malformedToolEvents() {
  const partial = withCall();
  return [
    { type: "toolcall_delta", contentIndex: 0, delta: '{"path"', partial },
    {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "t1", name: "read", arguments: {} },
      partial,
    },
  ] as AssistantMessageEvent[];
}

async function drain(events: AssistantMessageEvent[], signal?: AbortSignal): Promise<ProtocolEvent[]> {
  const output: ProtocolEvent[] = [];
  for await (const event of createPiProtocol("openai-completions", fakePi(events)).stream({
    ...BASE,
    ...(signal ? { signal } : {}),
  })) {
    output.push(event);
  }
  return output;
}

function eventTypes(events: ProtocolEvent[]) {
  return events.map((event) => event.type);
}

describe("createPiProtocol malformed tool arguments", () => {
  it("preserves terminal usage before the bad-request error", async () => {
    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "reading", partial: withCall() },
      ...malformedToolEvents(),
      { type: "done", reason: "toolUse", message: message({ usage: { ...message().usage, input: 100, output: 20 } }) },
    ] as AssistantMessageEvent[]);

    expect(events.some((event) => event.type === "tool-call" || event.type === "done")).toBe(false);
    const usageIndex = events.findIndex((event) => event.type === "usage");
    const errorIndex = events.findIndex((event) => event.type === "error");
    expect(events[usageIndex]).toEqual({
      type: "usage",
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 2, cacheWriteTokens: 1 },
    });
    expect(errorIndex).toBeGreaterThan(usageIndex);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "bad-request" } });
  });

  it("ignores text emitted after entering the malformed-arguments drain", async () => {
    const events = await drain([
      ...malformedToolEvents(),
      { type: "text_delta", contentIndex: 1, delta: "ignored", partial: withCall() },
      { type: "done", reason: "stop", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events.some((event) => event.type === "text-delta" && event.text === "ignored")).toBe(false);
  });

  it("preserves upstream error usage and reports one bad-request error", async () => {
    const events = await drain([
      ...malformedToolEvents(),
      {
        type: "error",
        reason: "error",
        error: message({
          stopReason: "error",
          errorMessage: "upstream failed",
          usage: { ...message().usage, input: 50, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50 },
        }),
      },
    ] as AssistantMessageEvent[]);

    expect(eventTypes(events)).toEqual(["tool-call-partial", "usage", "error"]);
    expect(events[1]).toEqual({
      type: "usage",
      usage: { inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    expect(events[2]).toMatchObject({
      type: "error",
      error: { kind: "bad-request", message: 'Tool "read" returned unparseable arguments.' },
    });
  });

  it("emits the remembered bad-request error if the upstream ends without a terminal event", async () => {
    const events = await drain(malformedToolEvents());

    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "bad-request" } });
    expect(events.some((event) => event.type === "usage")).toBe(false);
  });

  it("keeps the normal tool-call, usage, done sequence when arguments parse", async () => {
    const partial = withCall();
    const events = await drain([
      { type: "toolcall_delta", contentIndex: 0, delta: '{"path":"a.ts"}', partial },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
        partial,
      },
      { type: "done", reason: "toolUse", message: message() },
    ] as AssistantMessageEvent[]);

    expect(eventTypes(events)).toEqual(["tool-call-partial", "tool-call", "usage", "done"]);
  });

  it("rethrows the request abort when an upstream error arrives while draining", async () => {
    const controller = new AbortController();
    const abortReason = new DOMException("Aborted", "AbortError");
    controller.abort(abortReason);
    const events = [
      ...malformedToolEvents(),
      {
        type: "error",
        reason: "aborted",
        error: message({ stopReason: "aborted", errorMessage: "Request was aborted" }),
      },
    ] as AssistantMessageEvent[];
    const iterate = async () => drain(events, controller.signal);

    await expect(iterate()).rejects.toBe(abortReason);
  });

  it("replaces a thrown upstream failure with one remembered bad-request error", async () => {
    const stream = createPiProtocol("openai-completions", {
      resolveModel: async () => MODEL,
      stream: (_model: Model<Api>, _context: Context, _options: SimpleStreamOptions, _onResponse: unknown) => ({
        async *[Symbol.asyncIterator]() {
          for (const event of malformedToolEvents()) yield event;
          throw new Error("socket reset");
        },
      }),
    }).stream(BASE);
    const events: ProtocolEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "bad-request" } });
  });
});
