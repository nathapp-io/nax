import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPiProtocol, toPiContext, toPiOptions } from "../../src/protocols/pi-client.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import { runProtocolConformance } from "../support/conformance.ts";

// biome-ignore lint/suspicious/noExportsInTest: Task 6's conformance suite imports these helpers from this file.
export const MODEL: Model<Api> = {
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

/** Records what the protocol handed pi-ai, and replays scripted events. */
// biome-ignore lint/suspicious/noExportsInTest: Task 6's conformance suite imports this helper from this file.
export function fakePi(events: AssistantMessageEvent[]) {
  const calls: { model: Model<Api>; context: Context; options: SimpleStreamOptions }[] = [];
  const resolveCalls: { modelId: string; provider: string | undefined }[] = [];
  return {
    calls,
    resolveCalls,
    deps: {
      resolveModel: async (modelId: string, provider?: string) => {
        resolveCalls.push({ modelId, provider });
        return MODEL;
      },
      stream: (model: Model<Api>, context: Context, options: SimpleStreamOptions, _onResponse?: unknown) => {
        calls.push({ model, context, options });
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  };
}

const BASE: ProtocolRequest = { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] };

describe("toPiContext", () => {
  it("puts system in systemPrompt, never in messages", () => {
    const context = toPiContext({ ...BASE, system: "be terse" }, MODEL);
    expect(context.systemPrompt).toBe("be terse");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe("user");
  });

  it("omits systemPrompt when absent rather than sending an empty string", () => {
    expect(toPiContext(BASE, MODEL).systemPrompt).toBeUndefined();
  });

  it("maps an assistant turn with tool calls onto pi content blocks", () => {
    const context = toPiContext(
      {
        ...BASE,
        messages: [
          { role: "user", content: "read a.ts" },
          { role: "assistant", content: "on it", toolCalls: [{ id: "t1", name: "read", input: { path: "a.ts" } }] },
          { role: "tool-result", toolCallId: "t1", content: "contents" },
        ],
      },
      MODEL,
    );

    const assistant = context.messages[1];
    expect(assistant?.role).toBe("assistant");
    expect(assistant).toMatchObject({
      content: [
        { type: "text", text: "on it" },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
      ],
      api: "openai-completions",
      provider: "deepseek",
      model: "deepseek-chat",
    });
  });

  it("recovers toolName for a tool result from the call that produced it", () => {
    const context = toPiContext(
      {
        ...BASE,
        messages: [
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: {} }] },
          { role: "tool-result", toolCallId: "t1", content: "ok", isError: true },
        ],
      },
      MODEL,
    );

    expect(context.messages[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "t1",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "ok" }],
    });
  });

  it("throws on a tool result with no matching call, rather than sending an empty name", () => {
    expect(() =>
      toPiContext({ ...BASE, messages: [{ role: "tool-result", toolCallId: "ghost", content: "ok" }] }, MODEL),
    ).toThrow(/ghost/);
  });

  it("omits an empty assistant text block", () => {
    const context = toPiContext(
      { ...BASE, messages: [{ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", input: {} }] }] },
      MODEL,
    );
    expect(context.messages[0]).toMatchObject({ content: [{ type: "toolCall", id: "t1" }] });
  });
});

describe("toPiOptions", () => {
  it("forwards the neutral options under pi's names", () => {
    const options = toPiOptions({
      ...BASE,
      toolChoice: "none",
      maxTokens: 100,
      temperature: 0.5,
      cacheRetention: "long",
    });
    expect(options).toMatchObject({ toolChoice: "none", maxTokens: 100, temperature: 0.5, cacheRetention: "long" });
  });

  it("maps thinking onto reasoning", () => {
    expect(toPiOptions({ ...BASE, thinking: "high" }).reasoning).toBe("high");
  });

  it("omits reasoning entirely when thinking is off, since pi has no off level", () => {
    expect("reasoning" in toPiOptions({ ...BASE, thinking: "off" })).toBe(false);
  });

  it("omits every optional field that was not supplied", () => {
    expect(toPiOptions(BASE)).toEqual({});
  });
});

describe("createPiProtocol", () => {
  it("exposes the protocol name it was registered under", () => {
    expect(createPiProtocol("openai-completions", fakePi([]).deps).name).toBe("openai-completions");
  });

  it("resolves the model and calls pi-ai once with the translated request", async () => {
    const pi = fakePi([]);
    const protocol = createPiProtocol("openai-completions", pi.deps);
    for await (const _ of protocol.stream({ ...BASE, system: "be terse" })) {
      // drain
    }
    expect(pi.calls).toHaveLength(1);
    expect(pi.calls[0]?.model.id).toBe("deepseek-chat");
    expect(pi.calls[0]?.context.systemPrompt).toBe("be terse");
  });

  it("forwards the request's provider to model resolution", async () => {
    const pi = fakePi([]);
    const protocol = createPiProtocol("openai-completions", pi.deps);
    for await (const _ of protocol.stream({ ...BASE, provider: "openai-codex" })) {
      // drain
    }
    expect(pi.resolveCalls).toEqual([{ modelId: "deepseek-chat", provider: "openai-codex" }]);
  });
});

/** A minimal AssistantMessage, enough for the terminal events. */
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

async function drain(events: AssistantMessageEvent[]) {
  const out: ProtocolEvent[] = [];
  for await (const event of createPiProtocol("openai-completions", fakePi(events).deps).stream(BASE)) out.push(event);
  return out;
}

describe("createPiProtocol event mapping", () => {
  it("drops start, text_start and text_end, and emits only the deltas", async () => {
    const events = await drain([
      { type: "start", partial: message() },
      { type: "text_start", contentIndex: 0, partial: message() },
      { type: "text_delta", contentIndex: 0, delta: "he", partial: message() },
      { type: "text_delta", contentIndex: 0, delta: "llo", partial: message() },
      { type: "text_end", contentIndex: 0, content: "hello", partial: message() },
      { type: "done", reason: "stop", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events.filter((e) => e.type === "text-delta")).toEqual([
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
    ]);
  });

  it("maps thinking deltas and drops their start and end", async () => {
    const events = await drain([
      { type: "thinking_start", contentIndex: 0, partial: message() },
      { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: message() },
      { type: "thinking_end", contentIndex: 0, content: "hmm", partial: message() },
      { type: "text_delta", contentIndex: 1, delta: "ok", partial: message() },
      { type: "done", reason: "stop", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events).toContainEqual({ type: "thinking-delta", text: "hmm" });
  });

  it("recovers a partial tool call's id and name from partial.content", async () => {
    const withCall = (_args: string) =>
      message({ content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] });

    const events = await drain([
      { type: "toolcall_start", contentIndex: 0, partial: withCall("") },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"path"', partial: withCall('{"path"') },
      { type: "toolcall_delta", contentIndex: 0, delta: ':"a.ts"}', partial: withCall('{"path":"a.ts"}') },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
        partial: withCall('{"path":"a.ts"}'),
      },
      { type: "done", reason: "toolUse", message: message({ stopReason: "toolUse" }) },
    ] as AssistantMessageEvent[]);

    expect(events.filter((e) => e.type === "tool-call-partial")).toEqual([
      { type: "tool-call-partial", id: "t1", name: "read", rawInput: '{"path"' },
      { type: "tool-call-partial", id: "t1", name: "read", rawInput: '{"path":"a.ts"}' },
    ]);
    expect(events).toContainEqual({
      type: "tool-call",
      call: { id: "t1", name: "read", input: { path: "a.ts" } },
    });
  });

  it("emits usage immediately before done, synthesised from the final message", async () => {
    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "hi", partial: message() },
      { type: "done", reason: "stop", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events.slice(-2)).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
      },
      { type: "done", stopReason: "stop" },
    ]);
  });

  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["toolUse", "tool_use"],
  ] as const)("maps pi stop reason %s to %s", async (piReason, ours) => {
    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "hi", partial: message() },
      { type: "done", reason: piReason, message: message({ stopReason: piReason }) },
    ] as AssistantMessageEvent[]);

    expect(events.at(-1)).toEqual({ type: "done", stopReason: ours });
  });

  it("treats a deferred stop reason as a defect rather than mapping it to stop", async () => {
    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "hi", partial: message() },
      { type: "done", reason: "deferred", message: message({ stopReason: "deferred" }) },
    ] as AssistantMessageEvent[]);

    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "unknown" } });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("ends the stream on unparseable tool arguments without losing earlier events", async () => {
    const withCall = message({ content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] });

    const events = await drain([
      { type: "text_delta", contentIndex: 0, delta: "reading", partial: withCall },
      { type: "toolcall_delta", contentIndex: 0, delta: '{"path"', partial: withCall },
      {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: { type: "toolCall", id: "t1", name: "read", arguments: {} },
        partial: withCall,
      },
      { type: "done", reason: "toolUse", message: message() },
    ] as AssistantMessageEvent[]);

    expect(events[0]).toEqual({ type: "text-delta", text: "reading" });
    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "bad-request" } });
  });
});

/** Replays scripted events after reporting an HTTP response, as pi-ai does. */
function fakePiWithResponse(
  events: AssistantMessageEvent[],
  response?: { status: number; headers: Record<string, string> },
) {
  return {
    resolveModel: async () => MODEL,
    stream: (
      _model: Model<Api>,
      _context: Context,
      _options: SimpleStreamOptions,
      onResponse: (r: { status: number; headers: Record<string, string> }) => void,
    ) => {
      if (response) onResponse(response);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

async function drainWith(deps: ReturnType<typeof fakePiWithResponse>) {
  const out: ProtocolEvent[] = [];
  for await (const event of createPiProtocol("openai-completions", deps).stream(BASE)) out.push(event);
  return out;
}

describe("createPiProtocol error path", () => {
  it("classifies the error from the observed HTTP status, not the event", async () => {
    const events = await drainWith(
      fakePiWithResponse(
        [
          { type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: "slow down" }) },
        ] as AssistantMessageEvent[],
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );

    expect(events.at(-1)).toEqual({
      type: "error",
      error: { kind: "rate-limit", message: "slow down", status: 429, retryAfter: 30 },
    });
  });

  it("falls back to unknown when no response was observed", async () => {
    const events = await drainWith(
      fakePiWithResponse([
        { type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: "socket hang up" }) },
      ] as AssistantMessageEvent[]),
    );

    expect(events.at(-1)).toMatchObject({ type: "error", error: { kind: "unknown", message: "socket hang up" } });
    expect(events.at(-1)).not.toHaveProperty("error.status");
  });

  it("emits usage before the error, because a failed call still billed", async () => {
    const events = await drainWith(
      fakePiWithResponse(
        [
          { type: "text_delta", contentIndex: 0, delta: "part", partial: message() },
          { type: "error", reason: "error", error: message({ stopReason: "error", errorMessage: "boom" }) },
        ] as AssistantMessageEvent[],
        { status: 500, headers: {} },
      ),
    );

    expect(events.map((e) => e.type)).toEqual(["text-delta", "usage", "error"]);
  });

  it("omits usage when the failed message reported none", async () => {
    const zero = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const events = await drainWith(
      fakePiWithResponse(
        [
          { type: "error", reason: "error", error: message({ usage: zero, errorMessage: "boom" }) },
        ] as AssistantMessageEvent[],
        { status: 400, headers: {} },
      ),
    );

    expect(events.map((e) => e.type)).toEqual(["error"]);
  });

  it("emits nothing after an error", async () => {
    const events = await drainWith(
      fakePiWithResponse(
        [
          { type: "error", reason: "error", error: message({ errorMessage: "boom" }) },
          { type: "text_delta", contentIndex: 0, delta: "should not appear", partial: message() },
        ] as AssistantMessageEvent[],
        { status: 500, headers: {} },
      ),
    );

    expect(events.filter((e) => e.type === "text-delta")).toEqual([]);
  });

  it("reports an aborted stream as an error rather than a clean stop", async () => {
    const events = await drainWith(
      fakePiWithResponse([
        { type: "error", reason: "aborted", error: message({ stopReason: "aborted", errorMessage: "aborted" }) },
      ] as AssistantMessageEvent[]),
    );

    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});

/** A backend whose stream throws instead of yielding pi-ai's own "error" event
 * — the shape of a connection reset or DNS failure, which never reaches a
 * response to build a pi-ai error from. */
function fakePiThrowing(cause: unknown) {
  return {
    resolveModel: async () => MODEL,
    stream: (
      _model: Model<Api>,
      _context: Context,
      _options: SimpleStreamOptions,
      _onResponse: unknown,
    ): AsyncIterable<AssistantMessageEvent> => ({
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(cause) };
      },
    }),
  };
}

describe("createPiProtocol raw throw normalisation", () => {
  it("turns a thrown stream failure into a transport error event", async () => {
    const events: ProtocolEvent[] = [];
    for await (const event of createPiProtocol("openai-completions", fakePiThrowing(new Error("ECONNRESET"))).stream(
      BASE,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "error", error: { kind: "transport", message: "ECONNRESET", cause: expect.any(Error) } },
    ]);
  });

  it("does not dress up the caller's own abort as a transport fault", async () => {
    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    controller.abort(abortError);

    const iterate = async () => {
      const out: ProtocolEvent[] = [];
      for await (const event of createPiProtocol("openai-completions", fakePiThrowing(abortError)).stream({
        ...BASE,
        signal: controller.signal,
      })) {
        out.push(event);
      }
      return out;
    };

    await expect(iterate()).rejects.toBe(abortError);
  });
});

runProtocolConformance(
  "pi",
  async () =>
    createPiProtocol(
      "openai-completions",
      fakePi([
        { type: "text_delta", contentIndex: 0, delta: "hello", partial: message() },
        { type: "done", reason: "stop", message: message() },
      ] as AssistantMessageEvent[]).deps,
    ),
  { text: { name: "text", request: BASE } },
);
