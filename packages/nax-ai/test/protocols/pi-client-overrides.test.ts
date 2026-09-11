/**
 * ClientOptions.providerOverrides at the protocol seam (issue #36).
 *
 * The bug these cover is a two-catalog one: overrides patched the catalog
 * `client.model()` reads and not the one the protocol resolves against at
 * request time, so an override model priced and resolved correctly and then
 * threw on the first real request. Every test here therefore crosses the
 * protocol seam — one that stubs the client, or only asserts `client.model()`
 * resolves, passes against the bug.
 */

import type { Api, AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createClient } from "../../src/client.ts";
import { createPiDeps, createPiProtocol } from "../../src/protocols/pi-client.ts";
import type { ProtocolOptions } from "../../src/protocols/pi-protocols.ts";
import { normaliseCatalog } from "../../src/providers/catalog.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";
import type { ProviderOverride, ResolvedModel } from "../../src/providers/types.ts";

/** An id deliberately absent from pi-ai's bundled snapshot. */
const PHANTOM = "gpt-5.9-not-in-snapshot";

/** A model pi-ai's openai provider really does bundle, used as the control. */
const BUNDLED = "gpt-4";

const PHANTOM_MODEL: ResolvedModel = {
  id: PHANTOM,
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 },
  contextWindow: 987654,
  supportsTools: true,
  thinkingLevels: ["off", "high"],
};

const OVERRIDES: readonly ProviderOverride[] = [{ provider: "openai", models: [PHANTOM_MODEL] }];

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

/**
 * A client whose one protocol entry is the real pi protocol over a stubbed
 * stream. Built by hand rather than through `defaultProtocols` so the stub can
 * be injected; the options object is the same one both layers see.
 */
function clientOver(options: ProtocolOptions, streamSimple: ReturnType<typeof stubStream>["streamSimple"]) {
  return createClient({
    providers: [],
    providerOverrides: options.providerOverrides ?? [],
    protocols: {
      "openai-responses": { pi: async () => createPiProtocol("openai-responses", createPiDeps(options, streamSimple)) },
    },
  });
}

/** Drives deps.stream to completion for its side effect on the stub. */
async function drive(deps: ReturnType<typeof createPiDeps>, modelId: string, provider: string): Promise<Model<Api>> {
  const model = await deps.resolveModel(modelId, provider);
  for await (const _ of deps.stream(model, { messages: [] }, {}, () => {})) {
    // Drained: the stub records on first pull.
  }
  return model;
}

describe("provider overrides at the protocol seam", () => {
  it("reaches the wire for an override model instead of throwing Unknown model (#36)", async () => {
    const stub = stubStream();
    const client = clientOver({ providerOverrides: OVERRIDES }, stub.streamSimple);

    const model = await client.model("openai", PHANTOM);
    const result = await client.complete(model, { messages: [{ role: "user", content: "hi" }] });

    expect(result.stopReason).toBe("stop");
    expect(stub.models.map((m) => m.id)).toEqual([PHANTOM]);
    expect(stub.models[0]?.provider).toBe("openai");
    expect(stub.models[0]?.contextWindow).toBe(987654);
  });

  it("sends the override's own maxTokens when it declares one", async () => {
    const stub = stubStream();
    const deps = createPiDeps(
      { providerOverrides: [{ provider: "openai", models: [{ ...PHANTOM_MODEL, maxTokens: 2048 }] }] },
      stub.streamSimple,
    );

    await drive(deps, PHANTOM, "openai");

    expect(stub.models[0]?.maxTokens).toBe(2048);
  });

  it("templates an override from the provider's largest-context sibling, not the first in catalog order", async () => {
    const stub = stubStream();
    const deps = createPiDeps({ providerOverrides: OVERRIDES }, stub.streamSimple);

    await drive(deps, PHANTOM, "openai");

    const wire = stub.models[0];
    // The first openai-responses sibling in catalog order is gpt-4: 8192
    // context, 8192 output, text-only input. The largest is a 1,050,000-context
    // sibling with a 128,000 output ceiling that accepts images.
    expect(wire?.maxTokens).toBe(128_000);
    expect(wire?.input).toEqual(["text", "image"]);
  });

  it("keeps every bundled model of the overridden provider resolvable", async () => {
    const deps = createPiDeps({ providerOverrides: OVERRIDES }, stubStream().streamSimple);
    const bundled = await deps.resolveModel(BUNDLED, "openai");
    expect(bundled.id).toBe(BUNDLED);
  });

  it("does not leak an override into another client in the same process", async () => {
    const withOverrides = createPiDeps({ providerOverrides: OVERRIDES }, stubStream().streamSimple);
    const without = createPiDeps({}, stubStream().streamSimple);

    await expect(withOverrides.resolveModel(PHANTOM, "openai")).resolves.toMatchObject({ id: PHANTOM });
    await expect(without.resolveModel(PHANTOM, "openai")).rejects.toThrow(
      `Unknown model "${PHANTOM}" for provider "openai" in the pi-ai catalog.`,
    );
  });

  it("shares one catalog across deps built from the same overrides array", async () => {
    const options: ProtocolOptions = { providerOverrides: OVERRIDES };
    const first = await createPiDeps(options).resolveModel(PHANTOM, "openai");
    const second = await createPiDeps(options).resolveModel(PHANTOM, "openai");
    expect(first).toBe(second);
  });

  it("leaves the shared catalog untouched when no overrides are given", async () => {
    const first = await createPiDeps().resolveModel(BUNDLED, "openai");
    const second = await createPiDeps({}).resolveModel(BUNDLED, "openai");
    expect(first).toBe(second);
  });

  it("applies an override baseUrl to the override's own model and to bundled ones", async () => {
    const stub = stubStream();
    const deps = createPiDeps(
      { providerOverrides: [{ provider: "openai", baseUrl: "https://proxy.internal/v1", models: [PHANTOM_MODEL] }] },
      stub.streamSimple,
    );

    await drive(deps, PHANTOM, "openai");
    await drive(deps, BUNDLED, "openai");

    expect(stub.models.map((m) => [m.id, m.baseUrl])).toEqual([
      [PHANTOM, "https://proxy.internal/v1"],
      [BUNDLED, "https://proxy.internal/v1"],
    ]);
  });

  it("applies override headers to every model of the provider", async () => {
    const stub = stubStream();
    const deps = createPiDeps(
      { providerOverrides: [{ provider: "openai", headers: { "x-tenant": "acme" }, models: [PHANTOM_MODEL] }] },
      stub.streamSimple,
    );

    await drive(deps, BUNDLED, "openai");
    expect(stub.models[0]?.headers).toEqual({ "x-tenant": "acme" });
  });

  it("keeps the last of a repeated id, as the client-side catalog does", async () => {
    // normaliseCatalog stores into a Map, so the last entry wins there. The
    // wire resolves by first match, so an array here would keep the first and
    // the two catalogs would name different models for one id.
    const deps = createPiDeps({
      providerOverrides: [
        {
          provider: "openai",
          models: [
            { ...PHANTOM_MODEL, contextWindow: 111 },
            { ...PHANTOM_MODEL, contextWindow: 222 },
          ],
        },
      ],
    });

    const clientSide = normaliseCatalog(await defaultProviders(["openai"]), [
      {
        provider: "openai",
        models: [
          { ...PHANTOM_MODEL, contextWindow: 111 },
          { ...PHANTOM_MODEL, contextWindow: 222 },
        ],
      },
    ]);

    await expect(deps.resolveModel(PHANTOM, "openai")).resolves.toMatchObject({ contextWindow: 222 });
    expect(clientSide.model("openai", PHANTOM)?.contextWindow).toBe(222);
  });

  it("throws at construction for a provider the backend catalog does not know", () => {
    expect(() =>
      createPiDeps({
        providerOverrides: [
          { provider: "totally-made-up", models: [{ ...PHANTOM_MODEL, provider: "totally-made-up" }] },
        ],
      }),
    ).toThrow(/totally-made-up/);
  });

  it("throws at construction naming the model and the api when the provider has no sibling on it", () => {
    expect(() =>
      createPiDeps({
        providerOverrides: [{ provider: "openai", models: [{ ...PHANTOM_MODEL, protocol: "anthropic-messages" }] }],
      }),
    ).toThrow(new RegExp(`${PHANTOM}.*anthropic-messages|anthropic-messages.*${PHANTOM}`));
  });

  it("rejects an override model whose own provider field names a different provider", () => {
    // Symmetric with normaliseCatalog: the model would land in openai's bucket
    // keeping provider "anthropic", and createPiDeps.stream resolves auth from
    // model.provider — so the request would be signed for the wrong provider.
    let message = "";
    try {
      createPiDeps({
        providerOverrides: [{ provider: "openai", models: [{ ...PHANTOM_MODEL, provider: "anthropic" }] }],
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("openai");
    expect(message).toContain(PHANTOM);
    expect(message).toContain("anthropic");
  });

  it("lets an override win over a bundled id while every other bundled model survives", async () => {
    const collide: ResolvedModel = { ...PHANTOM_MODEL, id: BUNDLED, contextWindow: 4242 };
    const deps = createPiDeps({ providerOverrides: [{ provider: "openai", models: [collide] }] });

    const overridden = await deps.resolveModel(BUNDLED, "openai");
    expect(overridden.contextWindow).toBe(4242);
    expect(overridden.cost).toMatchObject({ input: 11, output: 22, cacheRead: 3, cacheWrite: 4 });

    // The count is asserted the only way the deps surface allows: every id the
    // bundled snapshot carries for this provider must still resolve. A rebuild
    // that dropped siblings, or an append that left the bundled gpt-4 ahead of
    // the override, both fail here.
    const [openai] = await defaultProviders(["openai"]);
    expect(openai?.models.length).toBeGreaterThan(1);
    for (const bundled of openai?.models ?? []) {
      await expect(deps.resolveModel(bundled.id, "openai")).resolves.toMatchObject({ id: bundled.id });
    }
  });
});
