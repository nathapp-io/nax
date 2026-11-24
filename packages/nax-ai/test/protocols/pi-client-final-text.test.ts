import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { type ClientRequest, createClient, type ProtocolFactory } from "../../src/client.ts";
import { createPiProtocol } from "../../src/protocols/pi-client.ts";
import type { ProtocolEvent, ProtocolRequest } from "../../src/protocols/types.ts";
import type { RawProvider } from "../../src/providers/catalog.ts";
import type { CompleteResult } from "../../src/types.ts";

/**
 * Text that arrives only on the terminal `text_end`.
 *
 * Self-contained by design: pi-client.test.ts is already over the file-size
 * limit, so its `fakePi` is not a reusable harness and must not be imported
 * here. Only `createPiProtocol(...).stream` and the public `createClient(...)`
 * are exercised — no fake ProtocolEvent stream stands in for the real adapter.
 */

const MODEL: Model<Api> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8000,
};

const BASE: ProtocolRequest = { model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] };

function fakePi(events: readonly AssistantMessageEvent[]) {
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

function textStart(contentIndex: number): AssistantMessageEvent {
  return { type: "text_start", contentIndex, partial: message() } as AssistantMessageEvent;
}

function textDelta(contentIndex: number, delta: string): AssistantMessageEvent {
  return { type: "text_delta", contentIndex, delta, partial: message() } as AssistantMessageEvent;
}

function textEnd(contentIndex: number, content: string): AssistantMessageEvent {
  return { type: "text_end", contentIndex, content, partial: message() } as AssistantMessageEvent;
}

function done(): AssistantMessageEvent {
  return { type: "done", reason: "stop", message: message() } as AssistantMessageEvent;
}

async function drain(events: readonly AssistantMessageEvent[]): Promise<ProtocolEvent[]> {
  const output: ProtocolEvent[] = [];
  for await (const event of createPiProtocol("openai-responses", fakePi(events)).stream(BASE)) output.push(event);
  return output;
}

/** Every text the stream answered with, in order. */
function textsOf(events: ProtocolEvent[]): string[] {
  return events.flatMap((event) => (event.type === "text-delta" ? [event.text] : []));
}

/** A one-provider catalog in the shape client.test.ts builds, resolving the model above. */
const PROVIDERS: readonly RawProvider[] = [
  {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: { kind: "api-key", env: "OPENAI_API_KEY" },
    defaultProtocol: "openai-responses",
    models: [
      {
        id: "gpt-5.4",
        pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8000,
        supportsTools: true,
        thinkingLevels: ["off"],
      },
    ],
  },
];

describe("createPiProtocol reconciles final-only text", () => {
  it("AC-1 emits the whole text when it arrives only on text_end", async () => {
    const events = await drain([textStart(0), textEnd(0, "42"), done()]);

    expect(textsOf(events)).toEqual(["42"]);
  });

  it("AC-3 (control) emits nothing extra when text_end only repeats the deltas", async () => {
    const events = await drain([textDelta(0, "he"), textDelta(0, "llo"), textEnd(0, "hello")]);

    expect(textsOf(events)).toEqual(["he", "llo"]);
  });

  it("AC-4 emits only the missing suffix when text_end completes the start of the deltas", async () => {
    const events = await drain([textDelta(0, "he"), textEnd(0, "hello")]);

    expect(textsOf(events)).toEqual(["he", "llo"]);
  });

  it("AC-5 (control) emits nothing more when text_end diverges from the deltas", async () => {
    const events = await drain([textDelta(0, "abc"), textEnd(0, "xyz")]);

    expect(textsOf(events)).toEqual(["abc"]);
  });

  it("AC-6 reconciles each content index independently", async () => {
    const events = await drain([textDelta(0, "A"), textEnd(0, "A"), textStart(1), textEnd(1, "B"), done()]);

    expect(textsOf(events)).toEqual(["A", "B"]);
  });

  it("AC-11 (control) never retracts emitted text, and an empty lone text_end adds nothing", async () => {
    const events = await drain([textDelta(0, "hello"), textEnd(0, "he"), textEnd(1, "")]);

    expect(textsOf(events)).toEqual(["hello"]);
  });
});

describe("createClient reconciles final-only text", () => {
  it("AC-2 returns the text a pi backend delivered only on text_end", async () => {
    const pi = fakePi([textStart(0), textEnd(0, "42"), done()]);
    const protocols: ProtocolFactory = () => ({
      "openai-responses": { pi: async () => createPiProtocol("openai-responses", pi) },
    });
    const client = createClient({ providers: PROVIDERS, protocols, transportRetries: 0 });
    const model = await client.model("openai", "gpt-5.4");
    const req: ClientRequest = { messages: [{ role: "user", content: "what is six times seven?" }] };

    const result: CompleteResult = await client.complete(model, req);

    expect(result.text).toBe("42");
    expect(result.stopReason).toBe("stop");
  });
});
