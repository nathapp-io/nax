/**
 * S3-3: fakes derive stream() from their scripted complete(). The events must
 * fold back, through nax-ai's own collectStream, to exactly the scripted result,
 * or every migrated fake would silently change what the loop sees.
 */
import { describe, expect, test } from "bun:test";
import { type Client, type CompleteResult, collectStream, type ResolvedModel } from "@nathapp/nax-ai";
import { streamFromComplete, withDerivedStream } from "#test/helpers/index";

const model: ResolvedModel = {
  id: "m",
  provider: "p",
  protocol: "openai-responses",
  pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  supportsTools: true,
  thinkingLevels: [],
};

const results: Record<string, CompleteResult> = {
  textOnly: { text: "hello", usage: { inputTokens: 1, outputTokens: 2 }, stopReason: "stop" },
  empty: { text: "", usage: { inputTokens: 1, outputTokens: 0 }, stopReason: "stop" },
  full: {
    text: "calling",
    usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 0 },
    stopReason: "tool_use",
    toolCalls: [{ id: "c1", name: "Read", input: { path: "a.ts" } }],
    thinking: [{ text: "first" }, { text: "second", signature: "sig" }],
    responseId: "resp-1",
    responseModel: "m-2",
  },
};

describe("streamFromComplete", () => {
  test("empty toolCalls / thinking arrays fold to absent, as the real collectStream does", async () => {
    const stream = streamFromComplete(async () => ({ ...results.textOnly, toolCalls: [], thinking: [] }));
    const folded = await collectStream(stream(model, { messages: [] }));
    expect(folded).not.toHaveProperty("toolCalls");
    expect(folded).not.toHaveProperty("thinking");
  });

  for (const [name, result] of Object.entries(results)) {
    test(`folds back to the scripted result: ${name}`, async () => {
      const stream = streamFromComplete(async () => result);
      expect(await collectStream(stream(model, { messages: [] }))).toEqual(result);
    });
  }

  test("forwards the model and request to complete()", async () => {
    let seen: unknown;
    const stream = streamFromComplete(async (_m, req) => {
      seen = req;
      return results.textOnly;
    });
    await collectStream(stream(model, { messages: [], sessionId: "s1" }));
    expect(seen).toEqual({ messages: [], sessionId: "s1" });
  });

  test("a rejecting complete() rejects the fold with the same error object", async () => {
    const boom = new Error("upstream exploded");
    const stream = streamFromComplete(async () => {
      throw boom;
    });
    expect(await collectStream(stream(model, { messages: [] })).catch((e: unknown) => e)).toBe(boom);
  });
});

describe("withDerivedStream", () => {
  test("binds late: a stream call reaches the client's complete() at call time", async () => {
    let calls = 0;
    const client: Client = withDerivedStream({
      model: async () => model,
      listModels: async () => [model],
      pricing: () => model.pricing,
      stream: async function* stream() {},
      complete: async () => {
        calls += 1;
        return results.textOnly;
      },
      validate: () => {},
    });
    expect(await collectStream(client.stream(model, { messages: [] }))).toEqual(results.textOnly);
    expect(calls).toBe(1);
  });
});
