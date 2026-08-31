import { describe, expect, it } from "vitest";
import { createClient } from "../src/client.ts";
import type { Protocol, ProtocolEvent } from "../src/protocols/types.ts";
import type { RawProvider } from "../src/providers/catalog.ts";

const PROVIDERS: readonly RawProvider[] = [
  {
    id: "deepseek",
    baseUrl: "https://api.deepseek.com",
    auth: { kind: "api-key", env: "DEEPSEEK_API_KEY" },
    defaultProtocol: "openai-completions",
    models: [
      {
        id: "deepseek-chat",
        pricing: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
        contextWindow: 64000,
        supportsTools: true,
        thinkingLevels: ["off", "medium"],
      },
    ],
  },
];

const scripted = (events: ProtocolEvent[]): Protocol => ({
  name: "openai-completions",
  async *stream() {
    for (const event of events) yield event;
  },
});

const OK: ProtocolEvent[] = [
  { type: "text-delta", text: "hi" },
  { type: "usage", usage: { inputTokens: 3, outputTokens: 1 } },
  { type: "done", stopReason: "stop" },
];

const makeClient = (events = OK) =>
  createClient({
    providers: PROVIDERS,
    protocols: { "openai-completions": { pi: async () => scripted(events) } },
  });

describe("client", () => {
  it("resolves a model from the catalog", async () => {
    const model = await makeClient().model("deepseek", "deepseek-chat");
    expect(model.protocol).toBe("openai-completions");
  });

  it("throws for an unknown model", async () => {
    await expect(makeClient().model("deepseek", "nope")).rejects.toThrow(/unknown model/i);
  });

  it("exposes pricing rates without computing cost", () => {
    const client = makeClient();
    const rates = client.pricing({
      id: "x",
      provider: "deepseek",
      protocol: "openai-completions",
      pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      supportsTools: false,
      thinkingLevels: [],
    });
    expect(rates).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("completes by collecting the stream", async () => {
    const client = makeClient();
    const model = await client.model("deepseek", "deepseek-chat");
    const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });
    expect(result.text).toBe("hi");
    expect(result.usage.inputTokens).toBe(3);
  });

  it("clamps a thinking level the model does not support", async () => {
    let seen: unknown;
    const client = createClient({
      providers: PROVIDERS,
      protocols: {
        "openai-completions": {
          pi: async () => ({
            name: "openai-completions",
            async *stream(req) {
              seen = req.thinking;
              for (const event of OK) yield event;
            },
          }),
        },
      },
    });
    const model = await client.model("deepseek", "deepseek-chat");
    await client.complete(model, { messages: [{ role: "user", content: "hi" }], thinking: "max" });
    expect(seen).toBe("medium"); // nearest supported
  });

  it("retries a transport-fault stream via the injected transportRetries option", async () => {
    let calls = 0;
    const client = createClient({
      providers: PROVIDERS,
      protocols: {
        "openai-completions": {
          pi: async () => ({
            name: "openai-completions",
            async *stream() {
              calls += 1;
              if (calls === 1) {
                throw new Error("connection reset");
              }
              for (const event of OK) yield event;
            },
          }),
        },
      },
      transportRetries: 1,
    });

    const model = await client.model("deepseek", "deepseek-chat");
    const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });

    expect(calls).toBe(2);
    expect(result.text).toBe("hi");
  });

  it("throws at createClient for a negative transportRetries, rather than clamping it", () => {
    expect(() => createClient({ providers: PROVIDERS, protocols: {}, transportRetries: -1 })).toThrow(
      /transportRetries/,
    );
  });

  it("validate() rejects a selection naming an unregistered backend", () => {
    const client = createClient({
      providers: PROVIDERS,
      protocols: { "openai-completions": { pi: async () => scripted(OK) } },
      backends: { byProtocol: { "openai-completions": "native" } },
    });
    expect(() => client.validate()).toThrow();
  });
});
