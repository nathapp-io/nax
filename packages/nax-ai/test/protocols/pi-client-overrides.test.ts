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
// Only this test file reaches past pi-ai's top-level export to exercise the
// real openai-completions wire-body builder via its `onPayload` hook — the
// one way to prove issue #47's fix at the actual wire, not merely at the
// synthesised Model. `check-pi-ai-imports` scans `src/`, not `test/`, so this
// does not weaken the adapter boundary the gate protects.
import { streamSimple as openaiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
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

/**
 * `ResolvedModel.thinkingLevelMap` and the thinking-aware `pickTemplate`
 * (issue #47).
 *
 * `opencode-go`'s real "openai-completions" siblings reproduce the reported
 * bug exactly: `kimi-k3` is the largest-context sibling on that api and its
 * map marks every level but "max" unsupported, while `deepseek-v4-flash` (a
 * touch smaller) maps "low"/"high"/"max" to themselves and carries
 * `compat.thinkingFormat: "deepseek"`. Pinning to those real ids is
 * deliberate, matching this file's existing style (`gpt-4`/`openai`) — a
 * synthetic fixture would not prove the fix against the catalog that
 * actually produced the bug report.
 */
describe("thinkingLevelMap synthesis (issue #47)", () => {
  /**
   * Drives an override model's synthesised pi Model through pi-ai's REAL
   * openai-completions wire-body builder, capturing the payload via its
   * `onPayload` hook before any network call is attempted (`fetch` is
   * stubbed to throw, so the request never actually leaves the process).
   * This is the only way to prove a `reasoning_effort`/`thinking` value
   * reaches the wire correctly, short of hitting a real provider.
   */
  async function wirePayload(
    model: Model<Api>,
    reasoning: "off" | "low" | "high" | "max" | "xhigh",
  ): Promise<Record<string, unknown> | undefined> {
    let captured: Record<string, unknown> | undefined;
    const events = openaiCompletionsStreamSimple(
      model as Parameters<typeof openaiCompletionsStreamSimple>[0],
      { messages: [] } as Context,
      {
        reasoning,
        apiKey: "test-key",
        fetch: async () => {
          throw new Error("stubbed — no network call should be needed to capture the payload");
        },
        onPayload: (params: unknown) => {
          captured = params as Record<string, unknown>;
          return params;
        },
      } as SimpleStreamOptions,
    );
    for await (const _ of events) {
      // Draining is what runs buildParams/onPayload; the eventual "error"
      // event (from the stubbed fetch) is expected and ignored.
    }
    return captured;
  }

  const OVERRIDE: ResolvedModel = {
    id: "deepseek-v4.1-flash",
    provider: "opencode-go",
    protocol: "openai-completions",
    pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 500_000,
    supportsTools: true,
    // The reported case: "off" plus three thinking levels, none of them the
    // lone "max" that kimi-k3's map would have left standing pre-fix.
    thinkingLevels: ["off", "low", "high", "max"],
  };

  it("templates the override off a level-compatible sibling, not the larger incompatible kimi-k3", async () => {
    const deps = createPiDeps({ providerOverrides: [{ provider: "opencode-go", models: [OVERRIDE] }] });
    const model = await deps.resolveModel(OVERRIDE.id, "opencode-go");

    expect(model.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max" });
    expect(model.compat).toMatchObject({ thinkingFormat: "deepseek" });
  });

  it("round-trips each declared level to the wire correctly, without collapsing to 'max'", async () => {
    const deps = createPiDeps({ providerOverrides: [{ provider: "opencode-go", models: [OVERRIDE] }] });
    const model = await deps.resolveModel(OVERRIDE.id, "opencode-go");

    // The exact regression: pre-fix, every one of these collapsed to
    // reasoning_effort "max" because the synthesised model's inherited map
    // only recognised "max".
    await expect(wirePayload(model, "low")).resolves.toMatchObject({ reasoning_effort: "low" });
    await expect(wirePayload(model, "high")).resolves.toMatchObject({ reasoning_effort: "high" });
    await expect(wirePayload(model, "max")).resolves.toMatchObject({ reasoning_effort: "max" });
  });

  it("never invents an 'off' value on the wire", async () => {
    const deps = createPiDeps({ providerOverrides: [{ provider: "opencode-go", models: [OVERRIDE] }] });
    const model = await deps.resolveModel(OVERRIDE.id, "opencode-go");

    const payload = await wirePayload(model, "off");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("prefers a level-compatible sibling over the larger-context incompatible one, falling back to size order otherwise", async () => {
    const compatible: ResolvedModel = { ...OVERRIDE, thinkingLevels: ["off", "low", "high", "max"] };
    // No single "opencode-go" sibling supports both "high" and "xhigh"
    // together in the real catalog (verified against the bundled snapshot),
    // so this forces the size-order fallback even under the new rule.
    const noCompatibleSibling: ResolvedModel = {
      ...OVERRIDE,
      id: "phantom-no-combo",
      thinkingLevels: ["off", "high", "xhigh"],
    };

    const deps = createPiDeps({
      providerOverrides: [{ provider: "opencode-go", models: [compatible, noCompatibleSibling] }],
    });

    const compatModel = await deps.resolveModel(compatible.id, "opencode-go");
    expect(compatModel.thinkingLevelMap).toMatchObject({ low: "low", high: "high", max: "max" });

    const fallbackModel = await deps.resolveModel(noCompatibleSibling.id, "opencode-go");
    // kimi-k3 (contextWindow 1,048,576) is the size-order winner among
    // opencode-go's openai-completions siblings; its map has no "xhigh" key,
    // so an incompatible fallback derives one via identity rather than
    // inheriting kimi-k3's stranger map wholesale.
    expect(fallbackModel.thinkingLevelMap).toMatchObject({ high: "high", xhigh: "xhigh" });
  });

  it("derives a map from the override's own levels when no compatible sibling exists, without inventing 'off'", async () => {
    const noCompatibleSibling: ResolvedModel = {
      ...OVERRIDE,
      id: "phantom-no-combo-2",
      thinkingLevels: ["off", "high", "xhigh"],
    };
    const deps = createPiDeps({ providerOverrides: [{ provider: "opencode-go", models: [noCompatibleSibling] }] });
    const model = await deps.resolveModel(noCompatibleSibling.id, "opencode-go");

    expect(model.thinkingLevelMap).toMatchObject({
      off: null, // kimi-k3's own "off" is null, so none is invented
      minimal: null, // undeclared levels map to null
      low: null,
      medium: null,
      high: "high", // declared, template maps it to null, so identity
      xhigh: "xhigh", // declared, template has no key at all, so identity
      max: null,
    });
  });

  it("still sends the wire's disable-thinking signal when the derived map's off is undefined, not null", async () => {
    // Regression: an earlier version of deriveThinkingLevelMap collapsed
    // "template has no 'off' key" (undefined) and "template marks off
    // unsupported" (null) into a single explicit null. pi's deepseek,
    // openrouter and string-thinking thinkingFormat branches distinguish
    // them via `model.thinkingLevelMap?.off !== null` — undefined reads true
    // (send the disable signal), null reads false (suppress it) — so writing
    // null where the template had no key silently dropped
    // `thinking: { type: "disabled" }` on every non-thinking request.
    //
    // No real "deepseek" provider sibling on openai-completions declares an
    // "off" key at all (verified against the bundled catalog), and none
    // supports "xhigh", so this override falls into Case 3 (derive) with a
    // deepseek-format template whose off is genuinely absent, not null.
    const noXhighSupport: ResolvedModel = {
      id: "deepseek-v4.2-flash",
      provider: "deepseek",
      protocol: "openai-completions",
      pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 500_000,
      supportsTools: true,
      thinkingLevels: ["off", "high", "xhigh"],
    };
    const deps = createPiDeps({ providerOverrides: [{ provider: "deepseek", models: [noXhighSupport] }] });
    const model = await deps.resolveModel(noXhighSupport.id, "deepseek");

    // The derived map itself must leave "off" unset, not null.
    expect(model.thinkingLevelMap?.off).toBeUndefined();
    expect("off" in (model.thinkingLevelMap ?? {})).toBe(false);

    const payload = await wirePayload(model, "off");
    expect(payload).toMatchObject({ thinking: { type: "disabled" } });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("lets an explicit ResolvedModel.thinkingLevelMap win over both the template's and the derived map", async () => {
    const explicit: ResolvedModel = {
      ...OVERRIDE,
      id: "phantom-explicit-map",
      // Deliberately incompatible with any real sibling, so the derive path
      // would otherwise run — proving the explicit map wins over it too, not
      // just over a compatible template's.
      thinkingLevels: ["off", "high", "xhigh"],
      thinkingLevelMap: { off: null, high: "custom-high", xhigh: "custom-xhigh" },
    };
    const deps = createPiDeps({ providerOverrides: [{ provider: "opencode-go", models: [explicit] }] });
    const model = await deps.resolveModel(explicit.id, "opencode-go");

    expect(model.thinkingLevelMap).toEqual({ off: null, high: "custom-high", xhigh: "custom-xhigh" });

    const payload = await wirePayload(model, "high");
    expect(payload).toMatchObject({ reasoning_effort: "custom-high" });
  });
});
