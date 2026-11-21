import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClientRequest, createClient, type ProtocolFactory } from "../../src/client.ts";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";
import { createPiProtocol } from "../../src/protocols/pi-client.ts";
import { defaultProtocols } from "../../src/protocols/pi-protocols.ts";
import type { ProtocolEvent, ProtocolRequest, ThinkingBlock } from "../../src/protocols/types.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";
import type { CompleteResult } from "../../src/types.ts";

const MODEL: Model<Api> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8000,
};

const BASE: ProtocolRequest = { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] };

afterEach(() => {
  vi.unstubAllGlobals();
});

interface DrainOptions {
  readonly signal?: AbortSignal;
  /** Thrown after the scripted events run out, the way a raw socket failure is. */
  readonly thrown?: Error;
}

function fakePi(events: readonly AssistantMessageEvent[], thrown?: Error) {
  return {
    resolveModel: async () => MODEL,
    stream: (_model: Model<Api>, _context: Context, _options: SimpleStreamOptions, _onResponse: unknown) =>
      (async function* () {
        for (const event of events) yield event;
        if (thrown !== undefined) throw thrown;
      })(),
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-responses" as Api,
    provider: "openai",
    model: "gpt-5.4",
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

/** A thinking content block, as pi-ai accumulates it onto the message it is streaming. */
function thinkingBlock(text: string, extra: Record<string, unknown> = {}) {
  return { type: "thinking", thinking: text, ...extra };
}

function thinkingEnd(contentIndex: number, text: string, partial: unknown): AssistantMessageEvent {
  return { type: "thinking_end", contentIndex, content: text, partial } as AssistantMessageEvent;
}

function textDelta(contentIndex: number, text: string, partial: unknown): AssistantMessageEvent {
  return { type: "text_delta", contentIndex, delta: text, partial } as AssistantMessageEvent;
}

function doneWith(overrides: Record<string, unknown> = {}): AssistantMessageEvent {
  return doneWithMessage(message(overrides));
}

/** A `done` carrying a message the test built itself, kept distinct from the early partial. */
function doneWithMessage(terminal: unknown): AssistantMessageEvent {
  return { type: "done", reason: "stop", message: terminal } as AssistantMessageEvent;
}

function errorEvent(errorMessage: string, usage: Record<string, unknown> = {}): AssistantMessageEvent {
  return {
    type: "error",
    reason: "error",
    error: message({ stopReason: "error", errorMessage, usage: { ...message().usage, ...usage } }),
  } as AssistantMessageEvent;
}

/** The in-progress `t1` block a delta finds its id and name on, alongside a signed thinking block. */
function partialWithCall() {
  return message({
    content: [
      thinkingBlock("hmm", { thinkingSignature: "sig-early" }),
      { type: "toolCall", id: "t1", name: "lookup", arguments: {} },
    ],
  });
}

/** A tool call whose accumulated deltas never parse, which arms the drain path. */
function malformedCall(partial: unknown): AssistantMessageEvent[] {
  return [
    { type: "toolcall_delta", contentIndex: 1, delta: '{"city"', partial },
    {
      type: "toolcall_end",
      contentIndex: 1,
      toolCall: { type: "toolCall", id: "t1", name: "lookup", arguments: {} },
      partial,
    },
  ] as AssistantMessageEvent[];
}

async function drainSettled(
  events: readonly AssistantMessageEvent[],
  options: DrainOptions = {},
): Promise<{ seen: ProtocolEvent[]; thrown: unknown }> {
  const seen: ProtocolEvent[] = [];
  let thrown: unknown;
  try {
    for await (const event of createPiProtocol("openai-responses", fakePi(events, options.thrown)).stream({
      ...BASE,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })) {
      seen.push(event);
    }
  } catch (cause) {
    thrown = cause;
  }
  return { seen, thrown };
}

async function drain(events: readonly AssistantMessageEvent[], options: DrainOptions = {}): Promise<ProtocolEvent[]> {
  const { seen, thrown } = await drainSettled(events, options);
  // A test that expected no rejection still gets one: silent loss would make
  // every "yields nothing" assertion pass for the wrong reason.
  if (thrown !== undefined) throw thrown;
  return seen;
}

function thinkingBlocks(events: readonly ProtocolEvent[]): ThinkingBlock[] {
  return events.flatMap((event) => (event.type === "thinking" ? [event.block] : []));
}

function eventTypes(events: readonly ProtocolEvent[]): string[] {
  return events.map((event) => event.type);
}

const EARLY = message({ content: [thinkingBlock("hmm", { thinkingSignature: "sig-early" })] });

describe("createPiProtocol terminal thinking signatures", () => {
  it("AC-1 takes the terminal signature over the one held from thinking_end", async () => {
    const terminal = message({ content: [thinkingBlock("hmm", { thinkingSignature: "sig-final" })] });
    const events = await drain([thinkingEnd(0, "hmm", EARLY), doneWithMessage(terminal)]);

    expect(thinkingBlocks(events)).toHaveLength(1);
    expect(thinkingBlocks(events)[0]).toEqual({ text: "hmm", signature: "sig-final" });
  });

  it("AC-2 emits the held block after the completed tool call", async () => {
    const partial = partialWithCall();
    const events = await drain([
      thinkingEnd(0, "hmm", partial),
      { type: "toolcall_delta", contentIndex: 1, delta: '{"city":"SG"}', partial },
      {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { type: "toolCall", id: "t1", name: "lookup", arguments: { city: "SG" } },
        partial,
      },
      doneWith(),
    ] as AssistantMessageEvent[]);

    expect(eventTypes(events).slice(-4)).toEqual(["tool-call", "thinking", "usage", "done"]);
  });

  it("AC-3 (control) keeps the thinking_end values when the terminal message holds no thinking block", async () => {
    const held = { text: "hmm", signature: "sig-early", redacted: false };
    const early = message({ content: [thinkingBlock("hmm", { thinkingSignature: "sig-early", redacted: false })] });

    const withoutBlock = await drain([thinkingEnd(0, "hmm", early), doneWith({ content: [] })]);
    expect(thinkingBlocks(withoutBlock)).toEqual([held]);

    const withTextBlock = await drain([
      thinkingEnd(0, "hmm", early),
      doneWith({ content: [{ type: "text", text: "not thinking" }] }),
    ]);
    expect(thinkingBlocks(withTextBlock)).toEqual([held]);
  });

  it("AC-4 takes the terminal redacted flag and its opaque signature over the held ones", async () => {
    const early = message({ content: [thinkingBlock("hmm", { redacted: false })] });
    const terminal = message({ content: [thinkingBlock("hmm", { thinkingSignature: "opaque", redacted: true })] });
    const events = await drain([thinkingEnd(0, "hmm", early), doneWithMessage(terminal)]);

    expect(thinkingBlocks(events)).toEqual([{ text: "hmm", signature: "opaque", redacted: true }]);
  });

  it("AC-5 emits held blocks in the order their thinking_end events arrived", async () => {
    const empty = message({ content: [] });
    const events = await drain([
      thinkingEnd(0, "a", empty),
      textDelta(1, "ok", empty),
      thinkingEnd(2, "b", empty),
      doneWith(),
    ]);

    expect(thinkingBlocks(events).map((block) => block.text)).toEqual(["a", "b"]);
    // Both arrive once the stream terminates, not at each thinking_end.
    expect(eventTypes(events)).toEqual(["text-delta", "thinking", "thinking", "usage", "done"]);
  });

  it("AC-6 (control) emits the held block with its thinking_end values before the error", async () => {
    // The error's own message carries a later signature: the error path still
    // reports what thinking_end held.
    const failing = message({
      stopReason: "error",
      errorMessage: "upstream failed",
      content: [thinkingBlock("hmm", { thinkingSignature: "sig-late" })],
    });
    const events = await drain([
      thinkingEnd(0, "hmm", EARLY),
      { type: "error", reason: "error", error: failing } as AssistantMessageEvent,
    ]);

    expect(thinkingBlocks(events)).toEqual([{ text: "hmm", signature: "sig-early" }]);
    expect(eventTypes(events).indexOf("thinking")).toBeLessThan(eventTypes(events).indexOf("error"));
    expect(events.at(-1)).toMatchObject({ type: "error", error: { message: "upstream failed" } });
  });

  it("AC-7 (control) emits the held block when the stream ends with no terminal event", async () => {
    const events = await drain([thinkingEnd(0, "hmm", EARLY)]);

    expect(events).toEqual([{ type: "thinking", block: { text: "hmm", signature: "sig-early" } }]);
  });

  it("AC-8 (control) emits the held block before the drain's usage event", async () => {
    const partial = partialWithCall();
    const events = await drain([thinkingEnd(0, "hmm", partial), ...malformedCall(partial), doneWith()]);

    expect(thinkingBlocks(events)).toHaveLength(1);
    expect(eventTypes(events).indexOf("thinking")).toBeLessThan(eventTypes(events).indexOf("usage"));
  });

  it("AC-9 (control) still ends the drain with the bad-request error", async () => {
    const partial = partialWithCall();
    const events = await drain([thinkingEnd(0, "hmm", partial), ...malformedCall(partial), doneWith()]);

    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: { kind: "bad-request", message: 'Tool "lookup" returned unparseable arguments.' },
    });
  });

  it("AC-10 (control) emits the held block before a thrown failure's error event", async () => {
    const events = await drain([thinkingEnd(0, "hmm", EARLY)], { thrown: new Error("socket reset") });

    expect(thinkingBlocks(events)).toEqual([{ text: "hmm", signature: "sig-early" }]);
    expect(eventTypes(events).indexOf("thinking")).toBeLessThan(eventTypes(events).indexOf("error"));
  });

  it("AC-11 rejects with the signal's abort reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Aborted", "AbortError");
    controller.abort(reason);

    await expect(
      drain([thinkingEnd(0, "hmm", EARLY), errorEvent("Request was aborted")], { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("AC-12 yields no thinking event when the aborted error ends the stream", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Aborted", "AbortError");
    controller.abort(reason);

    const { seen, thrown } = await drainSettled([thinkingEnd(0, "hmm", EARLY), errorEvent("Request was aborted")], {
      signal: controller.signal,
    });

    expect(thrown).toBe(reason);
    expect(thinkingBlocks(seen)).toEqual([]);
  });
});

describe("createPiProtocol held thinking on every non-terminal end", () => {
  it("AC-16 emits the held block ahead of an error's billed usage", async () => {
    const events = await drain([
      thinkingEnd(0, "hmm", EARLY),
      textDelta(1, "partial", message({ content: [] })),
      errorEvent("upstream failed", { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50 }),
    ]);

    expect(eventTypes(events)).toEqual(["text-delta", "thinking", "usage", "error"]);
    expect(thinkingBlocks(events)).toEqual([{ text: "hmm", signature: "sig-early" }]);
  });

  it("AC-17 emits the held block before the drain's terminal event when the drain ends on error", async () => {
    const partial = partialWithCall();
    const events = await drain([
      thinkingEnd(0, "hmm", partial),
      ...malformedCall(partial),
      errorEvent("upstream failed", { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50 }),
    ]);

    expect(eventTypes(events)).toEqual(["tool-call-partial", "thinking", "usage", "error"]);
    expect(thinkingBlocks(events)).toEqual([{ text: "hmm", signature: "sig-early" }]);
  });

  it("AC-18 keeps the thinking_end values when the drain ends on done with different terminal metadata", async () => {
    const partial = partialWithCall();
    const events = await drain([
      thinkingEnd(0, "hmm", EARLY),
      ...malformedCall(partial),
      doneWith({ content: [thinkingBlock("hmm", { thinkingSignature: "sig-late", redacted: true })] }),
    ]);

    expect(eventTypes(events)).toEqual(["tool-call-partial", "thinking", "usage", "error"]);
    expect(thinkingBlocks(events)).toEqual([{ text: "hmm", signature: "sig-early" }]);
  });
});

describe("createPiProtocol held thinking on an aborted request", () => {
  it("AC-19 (control) emits the aborted error's billed usage before rethrowing", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Aborted", "AbortError");
    controller.abort(reason);

    const { seen, thrown } = await drainSettled(
      [
        thinkingEnd(0, "hmm", EARLY),
        errorEvent("Request was aborted", { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 50 }),
      ],
      { signal: controller.signal },
    );

    expect(thrown).toBe(reason);
    expect(seen).toEqual([
      { type: "usage", usage: { inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]);
  });

  it("AC-20 (control) rethrows the same thrown failure", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));
    const failure = new Error("socket reset");

    const { thrown } = await drainSettled([thinkingEnd(0, "hmm", EARLY)], {
      signal: controller.signal,
      thrown: failure,
    });

    expect(thrown).toBe(failure);
  });

  it("AC-21 yields no held thinking block when the stream throws on an aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Aborted", "AbortError"));

    const { seen } = await drainSettled([thinkingEnd(0, "hmm", EARLY)], {
      signal: controller.signal,
      thrown: new Error("socket reset"),
    });

    expect(thinkingBlocks(seen)).toEqual([]);
  });
});

/** A fetch stand-in that streams `frames` as SSE, never two frames in one macrotask. */
function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  const pending = frames.map((frame) => encoder.encode(frame));
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A body that arrived as one chunk would let the terminal event be
      // handled in the same tick as the reasoning item before it, which is not
      // how a provider delivers one, and is what kept the real-pi short of the
      // shape this story is about.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const frame = pending[index++];
      if (frame === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(frame);
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function sse(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

const DONE_SENTINEL = "data: [DONE]\n\n";
const SUMMARY = [{ type: "summary_text", text: "pondering" }];

/**
 * One reasoning item's stream: `output_item.added`, then `output_item.done`
 * carrying whatever the provider put there, then a terminal `response.completed`
 * whose output is what pi-ai backfills the signature from.
 */
function reasoningFrames(itemDone: Record<string, unknown>, itemCompleted: Record<string, unknown>): string[] {
  return [
    sse("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "reasoning", id: "rs_1", summary: [] },
    }),
    sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: itemDone }),
    sse("response.completed", {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        output: [itemCompleted],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    }),
    DONE_SENTINEL,
  ];
}

/** The reasoning item a request body replays, found by its opaque provider id. */
function replayedReasoningItem(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const input = body.input;
  if (!Array.isArray(input)) return undefined;
  return input.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as { type?: unknown }).type === "reasoning",
  );
}

/**
 * Two `client.complete` calls through the real pi-ai backend, with only fetch
 * stubbed: the second replays the first result's thinking block on an assistant
 * message, the way a tool-calling consumer carries a turn forward.
 */
async function replayFirstThinking(
  frames: readonly string[],
): Promise<{ first: CompleteResult; secondBody: Record<string, unknown> }> {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return sseResponse(frames);
  });
  const credentials = createMemoryCredentialStore({ openai: { kind: "api-key", key: "sk-test" } });
  const protocols: ProtocolFactory = ({ providerOverrides }) => defaultProtocols({ credentials, providerOverrides });
  const client = createClient({ providers: await defaultProviders(), protocols, transportRetries: 0 });
  const model = await client.model("openai", "gpt-5.4");

  const ask: ClientRequest = { messages: [{ role: "user", content: "why is the sky blue" }] };
  const first = await client.complete(model, ask);
  const replay: ClientRequest = {
    messages: [
      { role: "user", content: "why is the sky blue" },
      { role: "assistant", content: "", thinking: first.thinking ?? [] },
    ],
  };
  await client.complete(model, replay);

  expect(bodies).toHaveLength(2);
  return { first, secondBody: bodies[1] as Record<string, unknown> };
}

describe("createClient terminal thinking signature (real pi-ai)", () => {
  it("AC-13 replays the reasoning item in a stateless second request", async () => {
    const { secondBody } = await replayFirstThinking(
      reasoningFrames(
        { type: "reasoning", id: "rs_1", summary: SUMMARY, status: "completed" },
        { type: "reasoning", id: "rs_1", summary: SUMMARY, encrypted_content: "opaque-fixture" },
      ),
    );

    expect(secondBody.store).toBe(false);
  });

  it("AC-14 carries the terminal encrypted_content pi-ai backfills at response.completed", async () => {
    const { first, secondBody } = await replayFirstThinking(
      reasoningFrames(
        { type: "reasoning", id: "rs_1", summary: SUMMARY, status: "completed" },
        { type: "reasoning", id: "rs_1", summary: SUMMARY, encrypted_content: "opaque-fixture" },
      ),
    );

    expect(first.thinking).toHaveLength(1);
    expect(replayedReasoningItem(secondBody)).toMatchObject({ id: "rs_1", encrypted_content: "opaque-fixture" });
  });

  it("AC-15 (control) replays an encrypted_content that already arrived on output_item.done", async () => {
    // The terminal event carries none, so only the signature pi-ai had on the
    // item can supply it — the control that holds on the old code too.
    const { secondBody } = await replayFirstThinking(
      reasoningFrames(
        { type: "reasoning", id: "rs_1", summary: SUMMARY, encrypted_content: "opaque-fixture" },
        { type: "reasoning", id: "rs_1", summary: SUMMARY },
      ),
    );

    expect(replayedReasoningItem(secondBody)).toMatchObject({ id: "rs_1", encrypted_content: "opaque-fixture" });
  });
});
