/**
 * Construction of the nax-ai client.
 *
 * defaultProviders() loads a ~650KB bundled catalog, so the client is built once and
 * memoised. Tests replace the builder through _clientDeps rather than reaching
 * the network or the catalog.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createClient, type ProtocolOptions } from "@nathapp/nax-ai";
import { assertNaxError, cleanupTempDir, makeTempDir, mockFetch } from "@test/helpers";
import { _clientDeps, _resetNativeClient, buildNativeClient, getNativeClient } from "@/agents/native/client";
import { _resetCredentialStore, naxCredentialStore } from "@/agents/native/credentials";
import type { ProviderCatalogOverride } from "@/config/schema-types";

const REAL_BUILD = _clientDeps.build;
// A real client with no providers and no protocols: constructing it loads no
// catalog and touches no network, so the builder swap counts builds, nothing
// more.
const FAKE_CLIENT = createClient({ providers: [], protocols: {} });

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

describe("getNativeClient", () => {
  test("builds the client once and reuses it", async () => {
    let built = 0;
    _clientDeps.build = async () => {
      built += 1;
      return FAKE_CLIENT;
    };

    const a = await getNativeClient();
    const b = await getNativeClient();

    expect(built).toBe(1);
    expect(a).toBe(b);
  });

  test("does not memoise a failed build, so a later call can succeed", async () => {
    let attempt = 0;
    _clientDeps.build = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("catalog unavailable");
      return FAKE_CLIENT;
    };

    await expect(getNativeClient()).rejects.toThrow("catalog unavailable");
    await expect(getNativeClient()).resolves.toBe(FAKE_CLIENT);
    expect(attempt).toBe(2);
  });
});

describe("buildNativeClient", () => {
  // test/preload.ts overwrites _clientDeps.build with a sentinel before any
  // test file loads, so the real builder is only reachable through this
  // named export, not through _clientDeps.build.
  test("constructs a real client synchronously, with no network reached", async () => {
    const client = await buildNativeClient();
    expect(typeof client.model).toBe("function");
    expect(typeof client.complete).toBe("function");
    expect(typeof client.pricing).toBe("function");
  });

  test("names nax to defaultProtocols, so provider dashboards can attribute its traffic", async () => {
    const realDefaultProtocols = _clientDeps.defaultProtocols;
    let seenClientApp: unknown;
    _clientDeps.defaultProtocols = ((options?: ProtocolOptions) => {
      seenClientApp = options?.clientApp;
      return realDefaultProtocols(options);
    }) as typeof _clientDeps.defaultProtocols;

    try {
      await buildNativeClient();
    } finally {
      _clientDeps.defaultProtocols = realDefaultProtocols;
    }

    // nax-ai owns which vendor spells this in which header (HTTP-Referer and
    // X-Title for OpenRouter); nax owns only the identity. Without it every
    // request carries pi-ai's hardcoded "pi (<platform> ...)" User-Agent and
    // nothing else, so nax traffic is indistinguishable from any other pi-ai
    // consumer's in the provider account paying for it.
    expect(seenClientApp).toEqual({ name: "nax", url: "https://github.com/nathapp-io/nax" });
  });

  test("passes the credential store to defaultProtocols, so a stored credential reaches a run", async () => {
    const realDefaultProtocols = _clientDeps.defaultProtocols;
    let seenCredentials: unknown;
    _clientDeps.defaultProtocols = ((options?: ProtocolOptions) => {
      seenCredentials = options?.credentials;
      return realDefaultProtocols(options);
    }) as typeof _clientDeps.defaultProtocols;

    try {
      // The real buildNativeClient, called directly (not through _clientDeps.build,
      // which test/preload.ts sentinels): this proves the seam nax-ai actually
      // reads (defaultProtocols). ClientOptions once carried a `credentials`
      // field that createClient never read; nax-ai 0.1.4 removed it.
      await buildNativeClient();
    } finally {
      _clientDeps.defaultProtocols = realDefaultProtocols;
    }

    expect(seenCredentials).toBe(naxCredentialStore());
  });
});

describe("catalog overrides", () => {
  function override(id: string): ProviderCatalogOverride {
    return {
      provider: "opencode-go",
      models: [
        {
          id,
          protocol: "openai-completions",
          contextWindow: 1_000_000,
          supportsTools: true,
          thinkingLevels: ["off"],
          pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
        },
      ],
    };
  }

  test("an override makes an id the bundled catalog does not know resolvable", async () => {
    // buildNativeClient is reached directly, not through _clientDeps.build
    // (test/preload.ts sentinels that). The real bundled catalog loads here,
    // as in the existing "constructs a real client" test.
    const client = await buildNativeClient([
      {
        provider: "anthropic",
        models: [
          {
            id: "nax-1982-override-probe",
            protocol: "anthropic-messages",
            contextWindow: 123_456,
            supportsTools: true,
            thinkingLevels: ["off", "high"],
            pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          },
        ],
      },
    ]);

    const resolved = await client.model("anthropic", "nax-1982-override-probe");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.contextWindow).toBe(123_456);
    expect(resolved.pricing.input).toBe(1);
  });

  test("a baseUrl override reaches the WIRE: the request goes to the proxy host (nax#2019)", async () => {
    // The seam that matters. Asserting the field was merely *passed* to
    // defaultProtocols proves nothing — #1982's lesson is that the client
    // resolved and priced happily and then threw at the first real request.
    // This reads the URL off the actual fetch, which is what pi dispatches
    // against: nax-ai applies the override to `Model.baseUrl`, not only to the
    // provider record (nax-ai protocols/pi-client.ts).
    const dir = makeTempDir("nax-2019-wire-");
    const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    const realFetch = globalThis.fetch;
    const seenUrls: string[] = [];

    try {
      // A dispatch needs a resolvable credential or it fails as "Provider is
      // not configured" before any URL is built. Seeded into a temp store, and
      // never sent anywhere: fetch is mocked below.
      process.env.NAX_GLOBAL_CONFIG_DIR = dir;
      _resetCredentialStore();
      await naxCredentialStore().modify("anthropic", async () => ({ kind: "api-key", key: "nax-2019-test-key" }));

      globalThis.fetch = mockFetch(async (input) => {
        seenUrls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        // A 500 stops the exchange here. The assertion is about where the
        // request went, not whether it succeeded.
        return new Response(JSON.stringify({ type: "error", error: { message: "stop" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      });

      const client = await buildNativeClient([
        {
          provider: "anthropic",
          baseUrl: "https://proxy.test/v1",
          models: [
            {
              id: "nax-2019-wire-probe",
              protocol: "anthropic-messages",
              contextWindow: 1000,
              supportsTools: false,
              thinkingLevels: ["off"],
              pricing: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
            },
          ],
        },
      ]);
      const model = await client.model("anthropic", "nax-2019-wire-probe");
      await client.complete(model, { messages: [{ role: "user", content: "hi" }] }).catch(() => undefined);
    } finally {
      globalThis.fetch = realFetch;
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
      _resetCredentialStore();
      cleanupTempDir(dir);
    }

    expect(seenUrls.length).toBeGreaterThan(0);
    for (const url of seenUrls) expect(url).toStartWith("https://proxy.test/v1");
  });

  test("an override survives to dispatch: complete() resolves it instead of throwing Unknown model (#1982)", async () => {
    const client = await buildNativeClient([
      {
        provider: "opencode-go",
        models: [
          {
            id: "nax-1982-dispatch-probe",
            protocol: "openai-completions",
            contextWindow: 1_000_000,
            supportsTools: true,
            thinkingLevels: ["off", "high"],
            pricing: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
          },
        ],
      },
    ]);

    const resolved = await client.model("opencode-go", "nax-1982-dispatch-probe");

    // Cross the protocol seam. client.model() reads the catalog createClient
    // patches; complete() resolves the model again inside the protocol layer,
    // which before nax-ai 0.1.11 was built from the pinned pi-ai snapshot alone
    // and threw `Unknown model "..." for provider "opencode-go" in the pi-ai
    // catalog.` on the first real request. test/preload.ts scrubs *_API_KEY and
    // isolates the credential store, so the next failure is deterministic auth
    // and nothing leaves the process.
    const err = await client
      .complete(resolved, {
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 1,
        sessionId: "nax-1982-dispatch-probe",
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain("Unknown model");
    expect(String(err)).toContain("not configured");
  });

  test("passes the override set to the builder and reuses one build for the same set", async () => {
    const set = [override("deepseek-flash")];
    let seen: readonly ProviderCatalogOverride[] | undefined;
    let built = 0;
    _clientDeps.build = async (received) => {
      seen = received;
      built += 1;
      return FAKE_CLIENT;
    };

    const a = await getNativeClient(set);
    const b = await getNativeClient(structuredClone(set));

    expect(seen).toEqual(set);
    expect(built).toBe(1);
    expect(a).toBe(b);
  });

  test("throws when called again with a different override set", async () => {
    _clientDeps.build = async () => FAKE_CLIENT;

    await getNativeClient([override("deepseek-flash")]);
    const err = await getNativeClient([override("mimo-v2-pro")]).catch((e: unknown) => e);
    assertNaxError(err, "native client override mismatch");
    expect(err.code).toBe("NATIVE_CLIENT_OVERRIDES_MISMATCH");
  });

  test("a failed build is not memoised, so a later different set can build", async () => {
    let attempt = 0;
    _clientDeps.build = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("catalog unavailable");
      return FAKE_CLIENT;
    };

    await expect(getNativeClient([override("deepseek-flash")])).rejects.toThrow("catalog unavailable");
    await expect(getNativeClient([override("mimo-v2-pro")])).resolves.toBe(FAKE_CLIENT);
    expect(attempt).toBe(2);
  });
});
