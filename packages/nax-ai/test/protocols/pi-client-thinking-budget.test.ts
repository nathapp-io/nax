import { afterEach, describe, expect, it, vi } from "vitest";
import { type ClientRequest, createClient, type ProtocolFactory } from "../../src/client.ts";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";
import { toPiOptions } from "../../src/protocols/pi-client.ts";
import { defaultProtocols } from "../../src/protocols/pi-protocols.ts";
import type { ProtocolEvent, ProtocolRequest, ThinkingLevel } from "../../src/protocols/types.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";
import type { ResolvedModel } from "../../src/providers/types.ts";

const MODEL: ResolvedModel = {
  id: "qwen3.8-flash",
  provider: "strata",
  protocol: "openai-completions",
  contextWindow: 131072,
  maxTokens: 32768,
  supportsTools: true,
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevels: ["off", "low", "medium", "high"],
  thinkingBudgetField: "reasoning_budget_tokens",
  thinkingBudgets: { low: 2048, medium: 6144 },
};
const { thinkingBudgets: _budgets, ...WITHOUT_BUDGETS } = MODEL;
afterEach(() => vi.unstubAllGlobals());

function recordingProtocols(provider: string, requests: ProtocolRequest[]): ProtocolFactory {
  return ({ providerOverrides }) => {
    const entries = defaultProtocols({
      credentials: createMemoryCredentialStore({ [provider]: { kind: "api-key", key: "k" } }),
      providerOverrides,
    });
    const backend = entries["openai-completions"];
    const load = backend?.pi;
    if (!backend || !load) throw new Error("Missing real pi backend");
    backend.pi = async () => {
      const protocol = await load();
      const original = protocol.stream.bind(protocol);
      vi.spyOn(protocol, "stream").mockImplementation((req) => {
        requests.push(req);
        return original(req);
      });
      return protocol;
    };
    return entries;
  };
}

async function wireBody(
  model: ResolvedModel,
  thinking?: ThinkingLevel,
  dispatchedModel?: ResolvedModel,
): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const requests: ProtocolRequest[] = [];
  vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: "intercepted", type: "authentication_error" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  });
  const client = createClient({
    providers: await defaultProviders(),
    protocols: recordingProtocols(model.provider, requests),
    transportRetries: 0,
    providerOverrides: [{ provider: model.provider, baseUrl: "http://127.0.0.1:18080/v1", models: [model] }],
  });
  const resolved = await client.model(model.provider, model.id);
  const events: ProtocolEvent[] = [];
  for await (const event of client.stream(dispatchedModel ?? resolved, {
    messages: [{ role: "user", content: "hello" }],
    ...(thinking !== undefined ? { thinking } : {}),
    // Untyped caller data must not leak, including when the model declares none.
    ...{ thinkingBudgets: { low: 1 } },
  }))
    events.push(event);
  expect(events).toContainEqual(expect.objectContaining({ type: "error" }));
  expect(bodies).toHaveLength(1);
  expect(requests).toHaveLength(1);
  if (model.thinkingBudgets === undefined) {
    expect(requests[0], "model-owned protocol budgets").not.toHaveProperty("thinkingBudgets");
  } else {
    expect(requests[0], "model-owned protocol budgets").toHaveProperty("thinkingBudgets", model.thinkingBudgets);
  }
  return bodies[0] as Record<string, unknown>;
}

const WIRE_CASES = [
  ["AC-1 low", MODEL, "low", 2048],
  ["AC-2 medium", MODEL, "medium", 6144],
  ["AC-3 default high", MODEL, "high", 16384],
  ["AC-4 off", MODEL, "off", undefined],
  ["AC-5 absent level", MODEL, undefined, undefined],
  ["AC-6 answer room", { ...MODEL, maxTokens: 4096, thinkingBudgets: { high: 16384 } }, "high", 3072],
  ["AC-7 no answer room", { ...MODEL, maxTokens: 1024 }, "low", undefined],
  [
    "AC-8 xhigh",
    { ...MODEL, thinkingLevels: [...MODEL.thinkingLevels, "xhigh"], thinkingBudgets: { high: 12000 } },
    "xhigh",
    12000,
  ],
  ["AC-9 no declaration", WITHOUT_BUDGETS, "low", 2048],
  ["AC-10 bundled together", { ...MODEL, provider: "together" }, "low", 2048],
] as const;

describe("createClient thinking-budget wire path", () => {
  it.each(WIRE_CASES)("%s sends the expected budget", async (_ac, model, thinking, expected) => {
    const body = await wireBody(model, thinking);
    if (expected === undefined) expect(body).not.toHaveProperty("reasoning_budget_tokens");
    else expect(body.reasoning_budget_tokens).toBe(expected);
  });
});

describe("wire assertion sensitivity", () => {
  it.each(WIRE_CASES)(
    "%s rejects a dropped or leaked declaration even when wire defaults match",
    async (_ac, model: ResolvedModel, thinking) => {
      const { thinkingBudgets, ...withoutBudgets } = model;
      const dispatchedModel =
        thinkingBudgets === undefined ? { ...model, thinkingBudgets: { low: 2048 } } : withoutBudgets;
      await expect(wireBody(model, thinking, dispatchedModel)).rejects.toThrow("model-owned protocol budgets");
    },
  );
});

describe("toPiOptions thinking budgets", () => {
  it("AC-11 forwards a copied budget declaration", () => {
    const thinkingBudgets = { low: 2048 };
    const req = { model: MODEL.id, messages: [], thinkingBudgets };
    const options = toPiOptions(req);
    expect(options.thinkingBudgets).toEqual({ low: 2048 });
    expect(options.thinkingBudgets).not.toBe(thinkingBudgets);
  });
  it("AC-12 omits absent budgets after forwarding a declaration", () => {
    // A positive control makes a mapper that ignores all budgets fail this case.
    const declared = toPiOptions({ model: MODEL.id, messages: [], thinkingBudgets: { low: 1234 } });
    expect(declared).toHaveProperty("thinkingBudgets", { low: 1234 });
    expect(toPiOptions({ model: MODEL.id, messages: [] })).not.toHaveProperty("thinkingBudgets");
    expect(declared).toHaveProperty("thinkingBudgets", { low: 1234 });
  });
});

describe("createClient model-only budget ownership", () => {
  it.each([
    ["AC-13 model declaration", { ...MODEL, thinkingBudgets: { low: 2048 } }, false, { low: 2048 }],
    ["AC-14 absent declaration", WITHOUT_BUDGETS, false, undefined],
    ["AC-15 stray caller declaration", WITHOUT_BUDGETS, true, undefined],
    ["model beats stray caller declaration", MODEL, true, MODEL.thinkingBudgets],
  ] as const)("%s", async (_ac, model, stray, expected) => {
    const seen: ProtocolRequest[] = [];
    const client = createClient({
      providers: [],
      protocols: {
        "openai-completions": {
          pi: async () => ({
            name: "openai-completions",
            async *stream(req) {
              seen.push(req);
              yield { type: "done", stopReason: "stop" };
            },
          }),
        },
      },
    });
    // Prove the same client forwards a declaration before testing absence, so
    // ignoring every budget cannot satisfy AC-14's negative assertion.
    await client.complete(MODEL, { messages: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveProperty("thinkingBudgets", MODEL.thinkingBudgets);
    seen.length = 0;
    const req = { messages: [], ...(stray ? { thinkingBudgets: { low: 1 } } : {}) } as ClientRequest;
    for await (const _ of client.stream(model, req)) {
      /* drain */
    }
    await client.complete(model, req);
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      if (expected === undefined) expect(request).not.toHaveProperty("thinkingBudgets");
      else expect(request).toHaveProperty("thinkingBudgets", expected);
    }
  });
});
