import { afterEach, describe, expect, mock, test } from "bun:test";
import { createMemoryCredentialStore } from "@nathapp/nax-ai";
import type { ProviderCatalogOverride } from "#src/config/catalog-overrides";
import { _adapterDeps } from "#src/native/adapter-deps";
import { _clientDeps, buildNativeClient } from "#src/native/client";
import { toProviderOverrides } from "#src/native/models";
import { NativeSessionAdapter } from "#src/native/session-adapter";
import { mockFetch } from "#test/helpers/index";

function strata(): ProviderCatalogOverride {
  return {
    provider: "strata",
    baseUrl: "http://192.168.1.175:8080/v1",
    authEnv: "STRATA_KEY",
    models: [
      {
        id: "qwen3.8-flash",
        protocol: "openai-completions",
        contextWindow: 131072,
        maxTokens: 32768,
        supportsTools: true,
        thinkingLevels: ["off", "low", "high"],
        pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}

const originalAdapterDeps = { ..._adapterDeps };
const originalProtocols = _clientDeps.defaultProtocols;
const originalFetch = globalThis.fetch;
const originalKey = process.env.STRATA_KEY;

afterEach(() => {
  Object.assign(_adapterDeps, originalAdapterDeps);
  _clientDeps.defaultProtocols = originalProtocols;
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.STRATA_KEY;
  else process.env.STRATA_KEY = originalKey;
});

describe("toProviderOverrides", () => {
  test("image AC-15 forwards declared model input", () => {
    const override = strata();
    override.models = override.models.map((model) => ({ ...model, input: ["text", "image"] }));
    expect(toProviderOverrides([override])[0]?.models?.[0]?.input).toEqual(["text", "image"]);
  });

  test("image AC-16 omits undeclared model input", () => {
    const model = toProviderOverrides([strata()])[0]?.models?.[0];
    expect(model).toBeDefined();
    expect(Object.hasOwn(model ?? {}, "input")).toBe(false);
  });

  test("AC-1 forwards custom provider authEnv", () => {
    const result = toProviderOverrides([strata()]);
    expect(result).toHaveLength(1);
    expect(result[0]?.authEnv).toBe("STRATA_KEY");
  });

  test("AC-2 omits undeclared authEnv", () => {
    const override = strata();
    delete override.authEnv;
    expect(Object.hasOwn(toProviderOverrides([override])[0] ?? {}, "authEnv")).toBe(false);
  });

  test("AC-3 forwards the openrouter thinking format", () => {
    const override = strata();
    override.models = override.models.map((model) => ({ ...model, thinkingFormat: "openrouter" }));
    expect(toProviderOverrides([override])[0]?.models?.[0]?.thinkingFormat).toBe("openrouter");
  });

  test("AC-4 never forwards allowInsecureHttp", () => {
    const override = { ...strata(), allowInsecureHttp: true } satisfies ProviderCatalogOverride;
    expect(Object.hasOwn(toProviderOverrides([override])[0] ?? {}, "allowInsecureHttp")).toBe(false);
  });
});

describe("buildNativeClient custom providers", () => {
  test("AC-5 passes authEnv to defaultProtocols exactly once", async () => {
    const spy = mock((options?: Parameters<typeof originalProtocols>[0]) => originalProtocols(options));
    _clientDeps.defaultProtocols = spy;
    await buildNativeClient([strata()], { credentials: createMemoryCredentialStore() });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.providerOverrides?.[0]?.authEnv).toBe("STRATA_KEY");
  });

  test("AC-6 streams to the custom URL with its environment bearer credential", async () => {
    process.env.STRATA_KEY = "k-wire";
    const requests: { url: string; authorization: string | null }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      requests.push({ url, authorization: headers.get("Authorization") });
      return new Response(JSON.stringify({ error: { message: "stop" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const client = await buildNativeClient([strata()], {
      transportRetries: 0,
      credentials: createMemoryCredentialStore(),
    });
    const model = await client.model("strata", "qwen3.8-flash");
    // Consume the actual protocol stream; the intercepted 401 ends it with an auth error.
    for await (const _event of client.stream(model, { messages: [{ role: "user", content: "hi" }] })) {
      // The request, rather than generated content, is the contract under test.
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toStartWith("http://192.168.1.175:8080/v1/chat/completions");
    expect(requests[0]?.authorization).toBe("Bearer k-wire");
  });
});

describe("NativeSessionAdapter.hasCredentials custom providers", () => {
  function isolateCredentials(value: string | undefined) {
    _adapterDeps.authSourceIsExec = async () => false;
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = mock(async () => false);
    _adapterDeps.readEnv = mock((name: string) => (name === "STRATA_KEY" ? value : undefined));
  }

  test("AC-7 accepts a declared non-empty authEnv before the ambient probe", async () => {
    isolateCredentials("k");
    expect(await new NativeSessionAdapter([strata()]).hasCredentials()).toBe(true);
    expect(_adapterDeps.readEnv).toHaveBeenCalledWith("STRATA_KEY");
    expect(_adapterDeps.anyAmbientCredential).not.toHaveBeenCalled();
  });

  test("AC-8 rejects an unset authEnv when no other credential exists", async () => {
    isolateCredentials(undefined);
    expect(await new NativeSessionAdapter([strata()]).hasCredentials()).toBe(false);
    expect(_adapterDeps.readEnv).toHaveBeenCalledWith("STRATA_KEY");
    expect(_adapterDeps.anyAmbientCredential).toHaveBeenCalledTimes(1);
  });

  test("rejects an empty authEnv value", async () => {
    isolateCredentials("");
    expect(await new NativeSessionAdapter([strata()]).hasCredentials()).toBe(false);
    expect(_adapterDeps.readEnv).toHaveBeenCalledWith("STRATA_KEY");
  });
});
