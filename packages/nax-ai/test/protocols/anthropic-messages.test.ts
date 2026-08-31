// test/protocols/anthropic-messages.test.ts
import { describe, expect, it } from "vitest";
import { createAnthropicMessagesPi, type PiStreamEvent } from "../../src/protocols/anthropic-messages/backend-pi.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import { runProtocolConformance } from "../support/conformance.ts";

const TEXT_REQUEST: ProtocolRequest = {
  model: "claude-x",
  system: "be terse",
  messages: [{ role: "user", content: "hi" }],
};

const TOOL_REQUEST: ProtocolRequest = {
  model: "claude-x",
  messages: [{ role: "user", content: "read a.ts" }],
  tools: [{ name: "read", description: "read a file", inputSchema: { type: "object" } }],
};

/** Scripted pi-ai-shaped events; no network. */
function fakePi(events: PiStreamEvent[], capture?: { request?: unknown }) {
  return {
    async *stream(request: unknown): AsyncIterable<PiStreamEvent> {
      if (capture) capture.request = request;
      for (const event of events) yield event;
    },
  };
}

const TEXT_EVENTS: PiStreamEvent[] = [
  { type: "text", text: "he" },
  { type: "text", text: "llo" },
  { type: "usage", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 } },
  { type: "done", stopReason: "stop" },
];

const TOOL_EVENTS: PiStreamEvent[] = [
  { type: "text", text: "reading" },
  { type: "tool-partial", id: "t1", name: "read", argsFragment: '{"path"' },
  { type: "tool-partial", id: "t1", name: "read", argsFragment: ':"a.ts"}' },
  { type: "tool-end", id: "t1", name: "read" },
  { type: "usage", usage: { input: 5, output: 2, cacheRead: 0, cacheWrite: 0 } },
  { type: "done", stopReason: "tool_use" },
];

async function collect(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const out: ProtocolEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("anthropic-messages pi backend", () => {
  it("maps text events to text deltas", async () => {
    const protocol = createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS) });
    const events = await collect(protocol.stream(TEXT_REQUEST));
    expect(events.filter((e) => e.type === "text-delta")).toEqual([
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
    ]);
  });

  it("maps pi usage onto TokenUsage, keeping cache fields separate", async () => {
    const protocol = createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS) });
    const events = await collect(protocol.stream(TEXT_REQUEST));
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toEqual({
      type: "usage",
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
    });
  });

  it("accumulates streamed tool arguments and emits one parsed tool call", async () => {
    const protocol = createAnthropicMessagesPi({ client: fakePi(TOOL_EVENTS) });
    const events = await collect(protocol.stream(TOOL_REQUEST));
    const calls = events.filter((e) => e.type === "tool-call");
    expect(calls).toEqual([{ type: "tool-call", call: { id: "t1", name: "read", input: { path: "a.ts" } } }]);
  });

  it("emits partials before the parsed call", async () => {
    const protocol = createAnthropicMessagesPi({ client: fakePi(TOOL_EVENTS) });
    const events = await collect(protocol.stream(TOOL_REQUEST));
    const lastPartial = events.map((e) => e.type).lastIndexOf("tool-call-partial");
    const firstFinal = events.findIndex((e) => e.type === "tool-call");
    expect(lastPartial).toBeLessThan(firstFinal);
  });

  it("emits an error event when tool arguments do not parse", async () => {
    // Malformed JSON from a provider must not throw out of the iterator: text
    // and usage already delivered would be lost.
    const protocol = createAnthropicMessagesPi({
      client: fakePi([
        { type: "tool-partial", id: "t1", name: "read", argsFragment: "{not json" },
        { type: "tool-end", id: "t1", name: "read" },
        { type: "done", stopReason: "tool_use" },
      ]),
    });
    const events = await collect(protocol.stream(TOOL_REQUEST));
    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    if (error?.type !== "error") throw new Error("unreachable");
    expect(error.error.kind).toBe("bad-request");
  });

  it("passes system prompt as a top-level field, not as a message", async () => {
    const capture: { request?: unknown } = {};
    const protocol = createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS, capture) });
    await collect(protocol.stream(TEXT_REQUEST));
    const request = capture.request as { system?: string; messages: unknown[] };
    expect(request.system).toBe("be terse");
    expect(request.messages).toHaveLength(1);
  });

  it("passes the requested thinking level to the adapter", async () => {
    const capture: { request?: unknown } = {};
    const protocol = createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS, capture) });
    await collect(protocol.stream({ ...TEXT_REQUEST, thinking: "high" }));
    expect((capture.request as { thinking?: string }).thinking).toBe("high");
  });
});

runProtocolConformance(
  "anthropic-messages (pi)",
  async () => createAnthropicMessagesPi({ client: fakePi(TEXT_EVENTS) }),
  { text: { name: "text", request: TEXT_REQUEST } },
);

runProtocolConformance(
  "anthropic-messages (pi, tools)",
  async () => createAnthropicMessagesPi({ client: fakePi(TOOL_EVENTS) }),
  {
    text: { name: "text", request: TOOL_REQUEST },
    tool: { name: "tool", request: TOOL_REQUEST },
  },
);
