import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "../../src/client.ts";
import { createMemoryCredentialStore } from "../../src/credentials/memory-store.ts";
import { createPiDeps } from "../../src/protocols/pi-client.ts";
import { defaultProtocols } from "../../src/protocols/pi-protocols.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";
import type { ProviderOverride, ResolvedModel } from "../../src/providers/types.ts";

const MODEL: ResolvedModel = {
  id: "qwen3.8-flash",
  provider: "strata",
  protocol: "openai-completions",
  contextWindow: 262144,
  maxTokens: 32768,
  supportsTools: true,
  thinkingLevels: ["off", "low", "medium", "high"],
  thinkingFormat: "openrouter",
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const STRATA: ProviderOverride = {
  provider: "strata",
  baseUrl: "http://192.168.1.175:8080/v1",
  authEnv: "STRATA_TEST_KEY",
  models: [MODEL],
};
const previousKey = process.env.STRATA_TEST_KEY;
afterEach(() => {
  if (previousKey === undefined) delete process.env.STRATA_TEST_KEY;
  else process.env.STRATA_TEST_KEY = previousKey;
});
function resolve() {
  return createPiDeps({ providerOverrides: [STRATA] }).resolveModel(MODEL.id, "strata");
}

describe("custom native providers", () => {
  it("AC-1 accepts a declared custom provider", () => {
    expect(() => createPiDeps({ providerOverrides: [STRATA] })).not.toThrow();
  });
  it("AC-2 synthesises the endpoint and model limits", async () => {
    expect(await resolve()).toMatchObject({
      baseUrl: STRATA.baseUrl,
      api: MODEL.protocol,
      provider: "strata",
      maxTokens: 32768,
    });
  });
  it("AC-3 carries the openrouter thinking format", async () => {
    expect((await resolve()).compat).toMatchObject({ thinkingFormat: "openrouter" });
  });
  it("AC-4 derives low without inventing an off key", async () => {
    const map = (await resolve()).thinkingLevelMap;
    expect(map).not.toHaveProperty("off");
    expect(map?.low).toBe("low");
  });
  it.each([
    ["AC-5", "k-123", false, "k-123"],
    ["AC-6", "k-123", true, "stored-1"],
    ["AC-7", undefined, false, undefined],
  ] as const)("%s resolves credentials at dispatch", async (_ac, env, stored, expected) => {
    // Build before setting env to prove resolution is dispatch-time, not construction-time.
    let captured: SimpleStreamOptions | undefined;
    const fakeStreamSimple = (_model: Model<Api>, _context: Context, options?: SimpleStreamOptions) => {
      captured = options;
      return (async function* (): AsyncGenerator<AssistantMessageEvent> {})();
    };
    const deps = createPiDeps(
      {
        providerOverrides: [STRATA],
        ...(stored
          ? {
              credentials: createMemoryCredentialStore({ strata: { kind: "api-key", key: "stored-1" } }),
            }
          : {}),
      },
      fakeStreamSimple,
    );
    if (env === undefined) delete process.env.STRATA_TEST_KEY;
    else process.env.STRATA_TEST_KEY = env;
    const model = await deps.resolveModel(MODEL.id, "strata");
    for await (const _ of deps.stream(model, { messages: [] }, {}, () => {})) {
      /* drain */
    }
    expect(captured).toBeDefined();
    if (expected === undefined) expect(captured).not.toHaveProperty("apiKey");
    else expect(captured?.apiKey).toBe(expected);
  });
  const { baseUrl: _baseUrl, ...withoutUrl } = STRATA;
  const { maxTokens: _maxTokens, ...withoutMax } = MODEL;
  it.each([
    ["AC-8", [withoutUrl], /strata.*baseUrl/],
    ["AC-9", [{ ...STRATA, models: [{ ...MODEL, protocol: "openai-responses" }] }], /qwen3\.8-flash.*openai-responses/],
    ["AC-10", [{ ...STRATA, models: [withoutMax] }], /qwen3\.8-flash.*maxTokens/],
    ["AC-11", [{ provider: "openai", authEnv: "X_KEY" }], /openai.*authEnv/],
    ["AC-14", [{ ...STRATA, models: [] }], /strata.*non-empty/],
    ["AC-15", [STRATA, STRATA], /strata.*introduced/],
  ] as const)("%s rejects invalid declarations", (_ac, overrides, error) => {
    expect(() => createPiDeps({ providerOverrides: overrides })).toThrow(error);
  });
  it("AC-12 preserves bundled models and catalog isolation", async () => {
    const deps = createPiDeps({ providerOverrides: [STRATA] });
    expect(await deps.resolveModel("gpt-4", "openai")).toMatchObject({ provider: "openai" });
    await expect(createPiDeps().resolveModel(MODEL.id, "strata")).rejects.toThrow(/strata/);
  });
  it("AC-13 resolves through the client with the default protocol factory", async () => {
    const client = createClient({
      providers: await defaultProviders(),
      protocols: defaultProtocols,
      providerOverrides: [STRATA],
    });
    expect(await client.model("strata", MODEL.id)).toMatchObject({
      provider: "strata",
      protocol: "openai-completions",
    });
  });
  it("synthesises mixed backends, copies headers and preserves explicit maps and routing", async () => {
    const headers = { "X-Tenant": "tenant" };
    const thinkingLevelMap = { off: "none", low: "minimal" };
    const { thinkingFormat: _format, ...plain } = MODEL;
    const deps = createPiDeps({
      providerOverrides: [
        {
          ...STRATA,
          headers,
          models: [
            { ...MODEL, thinkingLevelMap, openRouterRouting: { only: ["host"] } },
            { ...plain, id: "claude-custom", protocol: "anthropic-messages", thinkingLevels: [] },
          ],
        },
      ],
    });
    headers["X-Tenant"] = "changed";
    const model = await deps.resolveModel(MODEL.id, "strata");
    expect(model).toMatchObject({
      name: MODEL.id,
      input: ["text"],
      contextWindow: 262144,
      headers: { "X-Tenant": "tenant" },
      thinkingLevelMap,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { thinkingFormat: "openrouter", openRouterRouting: { only: ["host"] } },
    });
    expect(await deps.resolveModel("claude-custom", "strata")).toMatchObject({
      api: "anthropic-messages",
      reasoning: false,
    });
  });
  it.each([
    [{ ...MODEL, provider: "other" }, /strata.*qwen3/],
    [{ ...MODEL, openRouterRouting: {} }, /openRouterRouting/],
    [{ ...MODEL, protocol: "anthropic-messages" }, /thinkingFormat/],
    [{ ...MODEL, protocol: "anthropic-messages", openRouterRouting: { only: ["host"] } }, /openRouterRouting/],
  ])("applies shared model validation to introductions (%j)", (model, error) => {
    expect(() => createPiDeps({ providerOverrides: [{ ...STRATA, models: [model] }] })).toThrow(error);
  });
  it("accepts introductions without authEnv and retains last-model-wins semantics", async () => {
    const { authEnv: _env, ...override } = STRATA;
    const deps = createPiDeps({ providerOverrides: [{ ...override, models: [MODEL, { ...MODEL, maxTokens: 123 }] }] });
    expect((await deps.resolveModel(MODEL.id, "strata")).maxTokens).toBe(123);
  });
  it("AC-16 enables reasoning", async () => {
    expect((await resolve()).reasoning).toBe(true);
  });
  it.each([
    ["AC-17", undefined, "none"],
    ["AC-18", "low", "low"],
  ] as const)("%s sends the real openrouter reasoning payload", async (_ac, reasoning, effort) => {
    const model = await resolve();
    let captured: unknown;
    const events = streamSimple(model as Parameters<typeof streamSimple>[0], normalizeContext({ messages: [] }), {
      apiKey: "test-key",
      ...(reasoning !== undefined ? { reasoning } : {}),
      fetch: async () => {
        throw new Error("intercepted: no network");
      },
      onPayload: (payload: unknown) => {
        captured = payload;
        return payload;
      },
    } as SimpleStreamOptions);
    for await (const _ of events) {
      /* run payload builder, then intercepted fetch */
    }
    expect(captured).toMatchObject({ reasoning: { effort } });
  });
});
