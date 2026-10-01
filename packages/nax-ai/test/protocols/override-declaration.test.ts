/**
 * The two-place wiring hazard behind issue #36.
 *
 * The fix for #36 made `providerOverrides` a protocol-side option as well as a
 * client-side one, which means a consumer must now declare the same array
 * twice. Declaring it only on the client reproduces #36 exactly — the model
 * resolves, prices, and then throws "Unknown model" on the first real request —
 * so the omission has to be loud at construction rather than silent until the
 * wire. These cover both halves: the construction-time check, and the factory
 * form that lets a consumer declare the array once instead.
 */

import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createClient } from "../../src/client.ts";
import { recordDeclaredOverrides } from "../../src/protocols/override-declaration.ts";
import { createPiDeps, createPiProtocol } from "../../src/protocols/pi-client.ts";
import { defaultProtocols } from "../../src/protocols/pi-protocols.ts";
import type { ProtocolEntries } from "../../src/protocols/registry.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";
import type { ProviderOverride, ResolvedModel } from "../../src/providers/types.ts";

const PHANTOM = "gpt-5.9-not-in-snapshot";

const PHANTOM_MODEL: ResolvedModel = {
  id: PHANTOM,
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 },
  contextWindow: 987654,
  supportsTools: true,
  thinkingLevels: ["off", "high"],
};

const overrides = (): readonly ProviderOverride[] => [{ provider: "openai", models: [{ ...PHANTOM_MODEL }] }];

/** Records the model pi-ai was handed, and ends the stream immediately. */
function stubStream() {
  const models: Model<Api>[] = [];
  const streamSimple = (model: Model<Api>, _context: Context, _options?: SimpleStreamOptions) => {
    models.push(model);
    return (async function* (): AsyncGenerator<AssistantMessageEvent> {
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      } as AssistantMessageEvent;
    })();
  };
  return { models, streamSimple };
}

/** The real pi protocol over a stubbed stream, as one hand-built entry. */
function stubbedEntries(
  options: { readonly providerOverrides?: readonly ProviderOverride[] },
  streamSimple: ReturnType<typeof stubStream>["streamSimple"],
): ProtocolEntries {
  return {
    "openai-responses": { pi: async () => createPiProtocol("openai-responses", createPiDeps(options, streamSimple)) },
  };
}

describe("provider overrides must be declared on both sides (#36)", () => {
  it("throws at construction when the protocol side declares no overrides at all", () => {
    expect(() =>
      createClient({ providers: [], providerOverrides: overrides(), protocols: defaultProtocols() }),
    ).toThrow(new RegExp(`${PHANTOM}[\\s\\S]*defaultProtocols|defaultProtocols[\\s\\S]*${PHANTOM}`));
  });

  it("names the provider and the missing model, and points at issue #36", () => {
    let message = "";
    try {
      createClient({ providers: [], providerOverrides: overrides(), protocols: defaultProtocols() });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("openai");
    expect(message).toContain(PHANTOM);
    expect(message).toContain("providerOverrides");
    expect(message).toContain("#36");
  });

  it("throws for a baseUrl-only override the protocol side does not set", () => {
    expect(() =>
      createClient({
        providers: [],
        providerOverrides: [{ provider: "openai", baseUrl: "https://proxy.internal/v1" }],
        protocols: defaultProtocols(),
      }),
    ).toThrow(/baseUrl[\s\S]*https:\/\/proxy\.internal\/v1|https:\/\/proxy\.internal\/v1[\s\S]*baseUrl/);
  });

  it("throws for headers the protocol side does not set", () => {
    expect(() =>
      createClient({
        providers: [],
        providerOverrides: [{ provider: "openai", headers: { "x-tenant": "acme" } }],
        protocols: defaultProtocols(),
      }),
    ).toThrow(/headers/);
  });

  it("accepts two separately-constructed but content-equal arrays, and still crosses the seam", async () => {
    const clientSide = overrides();
    const protocolSide = overrides();
    expect(protocolSide).not.toBe(clientSide);
    expect(protocolSide).toEqual(clientSide);

    const stub = stubStream();
    const entries = stubbedEntries({ providerOverrides: protocolSide }, stub.streamSimple);
    recordDeclaredOverrides(entries, protocolSide);

    const client = createClient({ providers: [], providerOverrides: clientSide, protocols: entries });
    const model = await client.model("openai", PHANTOM);
    const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });

    expect(result.stopReason).toBe("stop");
    expect(stub.models.map((m) => m.id)).toEqual([PHANTOM]);
  });

  it("does not demand a declaration for an override of a model the base catalog carries", async () => {
    // Amending a bundled model — correcting stale pricing is the usual reason —
    // works today with no protocol-side declaration at all: pricing never
    // crosses the wire, and the backend resolves the id from its own catalog.
    // Failing this would break wiring that is already correct.
    const providers = await defaultProviders(["openai"]);
    const bundled = providers[0]?.models[0];
    if (bundled === undefined) throw new Error("expected a bundled openai model");

    const repriced: ResolvedModel = {
      id: bundled.id,
      provider: "openai",
      protocol: bundled.protocol ?? "openai-responses",
      pricing: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
      contextWindow: bundled.contextWindow,
      supportsTools: bundled.supportsTools,
      thinkingLevels: bundled.thinkingLevels,
    };

    const client = createClient({
      providers,
      providerOverrides: [{ provider: "openai", models: [repriced] }],
      protocols: defaultProtocols(),
    });

    await expect(client.model("openai", bundled.id)).resolves.toMatchObject({ pricing: { input: 99 } });
  });

  it("still throws for a model the base catalog does not carry", async () => {
    // The other side of the same coin: a post-snapshot model has nowhere else
    // to be found, so an undeclared protocol side is issue #36.
    const providers = await defaultProviders(["openai"]);
    expect(() => createClient({ providers, providerOverrides: overrides(), protocols: defaultProtocols() })).toThrow(
      new RegExp(PHANTOM),
    );
  });

  it("does not throw when the protocol side declares more than the client does", () => {
    expect(() =>
      createClient({
        providers: [],
        providerOverrides: overrides(),
        protocols: defaultProtocols({
          providerOverrides: [
            { provider: "openai", models: [{ ...PHANTOM_MODEL }] },
            { provider: "anthropic", baseUrl: "https://anthropic.internal" },
          ],
        }),
      }),
    ).not.toThrow();
  });

  it("skips the check entirely for hand-built entries that declared nothing", async () => {
    const stub = stubStream();
    const clientSide = overrides();
    const client = createClient({
      providers: [],
      providerOverrides: clientSide,
      protocols: stubbedEntries({ providerOverrides: clientSide }, stub.streamSimple),
    });

    const model = await client.model("openai", PHANTOM);
    const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });

    expect(result.stopReason).toBe("stop");
    expect(stub.models.map((m) => m.id)).toEqual([PHANTOM]);
  });
});

describe("the protocols factory declares overrides exactly once (#36)", () => {
  it("hands the client's own overrides to the factory and reaches the wire with them", async () => {
    const stub = stubStream();
    const clientSide = overrides();
    const seen: (readonly ProviderOverride[])[] = [];

    const client = createClient({
      providers: [],
      providerOverrides: clientSide,
      protocols: (o) => {
        seen.push(o.providerOverrides);
        return stubbedEntries(o, stub.streamSimple);
      },
    });

    const model = await client.model("openai", PHANTOM);
    const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(clientSide);
    expect(result.stopReason).toBe("stop");
    expect(stub.models.map((m) => m.id)).toEqual([PHANTOM]);
    expect(stub.models[0]?.contextWindow).toBe(987654);
  });

  it("passes an empty array to the factory when the client declares no overrides", () => {
    const seen: (readonly ProviderOverride[])[] = [];
    createClient({
      providers: [],
      protocols: (o) => {
        seen.push(o.providerOverrides);
        return defaultProtocols(o);
      },
    });
    expect(seen).toEqual([[]]);
  });
});
