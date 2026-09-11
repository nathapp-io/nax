/**
 * providerOverrides against a real provider, over the wire (issues #36, #37).
 *
 * The offline suite proves the seam resolves and dispatches, but stubs the
 * stream — so nothing there shows that a model the pinned pi-ai snapshot has
 * never heard of actually completes at the provider. That is the whole point
 * of the option, and it is the one claim a stub cannot make.
 *
 * `deepseek-flash` is live at opencode-go and absent from pi-ai 0.84.4's
 * bundled catalog, so it is the real instance of the case #36 described.
 * Re-probe the gap with:
 *   curl -H "Authorization: Bearer $KEY" https://opencode.ai/zen/go/v1/models
 */

import { describe, expect, it } from "vitest";
import { createClient } from "../../src/client.ts";
import { defaultProtocols } from "../../src/protocols/pi-protocols.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";
import type { ProviderOverride } from "../../src/providers/types.ts";
import { piAuthStore } from "./support/pi-auth-store.ts";

const PROVIDER = "opencode-go";
const MODEL = "deepseek-flash";

const OVERRIDES: readonly ProviderOverride[] = [
  {
    provider: PROVIDER,
    models: [
      {
        id: MODEL,
        provider: PROVIDER,
        protocol: "openai-completions",
        pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        supportsTools: true,
        thinkingLevels: ["off"],
      },
    ],
  },
];

describe("providerOverrides reach a live provider", () => {
  it("completes a model the pinned snapshot does not carry", async () => {
    const providers = await defaultProviders();
    const bundled = providers.find((p) => p.id === PROVIDER);
    // The premise: if a later pi-ai bump adds this model, the test is no
    // longer testing an override and should be repointed at a newer id.
    expect(bundled?.models.some((m) => m.id === MODEL)).toBe(false);

    const credentials = piAuthStore();
    const client = createClient({
      providers,
      providerOverrides: OVERRIDES,
      // The factory form: the overrides are declared once and the client
      // hands them to the protocol side itself.
      protocols: (o) => defaultProtocols({ ...o, credentials }),
    });

    const model = await client.model(PROVIDER, MODEL);
    expect(model.contextWindow).toBe(128_000);

    const result = await client.complete(model, {
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
      maxTokens: 64,
      // opencode routes on x-opencode-session and rejects a request without
      // it; nax-ai spells that header from sessionId (see session-id.ts).
      sessionId: `nax-ai-live-${Date.now()}`,
    });

    // Either terminator proves the wire worked; which one depends on how
    // chatty the model is under the cap, which is not what this asserts.
    expect(["stop", "length"]).toContain(result.stopReason);
    expect(result.text.trim().length).toBeGreaterThan(0);
    console.log(
      `LIVE ${PROVIDER}/${MODEL} -> ${JSON.stringify(result.text.trim())} (usage ${JSON.stringify(result.usage)})`,
    );
  }, 120_000);

  // Not #36 itself — #36 was a model that resolved and then failed at the
  // wire. This is the state that motivates the option: without an override the
  // pinned snapshot does not carry the model at all, so it is unreachable.
  it("is unreachable without the override, because the pinned snapshot lacks it", async () => {
    const providers = await defaultProviders();
    const credentials = piAuthStore();
    const client = createClient({ providers, protocols: defaultProtocols({ credentials }) });

    await expect(client.model(PROVIDER, MODEL)).rejects.toThrow();
  }, 30_000);
});
