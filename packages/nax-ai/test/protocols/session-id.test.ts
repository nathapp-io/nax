/**
 * Per-request session id.
 *
 * A session id is a wire concern, not a consumer concept: pi-ai already models
 * it (`SimpleStreamOptions.sessionId` — "providers can use this to enable
 * prompt caching, request routing, or other session-aware features"), and this
 * package's job is to reach it. What a session *is* stays the consumer's to
 * decide; nax-ai only carries the id and knows which vendors want it spelled
 * out in a header of their own.
 *
 * Forwarding the id is most of the value: pi-ai selects `x-session-id`,
 * `session_id`, `x-client-request-id` and `x-session-affinity` from a per-MODEL
 * compat flag, and keys prompt caching off the same value. OpenCode is the
 * exception pi-ai has no support for at all.
 */
import type { AssistantMessageEvent, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createPiDeps, toPiOptions } from "../../src/protocols/pi-client.ts";
import { vendorSessionHeaders } from "../../src/protocols/session-id.ts";
import type { ProtocolRequest } from "../../src/protocols/types.ts";

const BASE: ProtocolRequest = { model: "m", messages: [] };

async function* emptyStream(): AsyncGenerator<AssistantMessageEvent> {}

describe("toPiOptions sessionId", () => {
  it("forwards the session id, which is what drives pi's own affinity and caching", () => {
    expect(toPiOptions({ ...BASE, sessionId: "s-1" }).sessionId).toBe("s-1");
  });

  it("omits it entirely when the caller supplied none", () => {
    expect("sessionId" in toPiOptions(BASE)).toBe(false);
  });
});

describe("vendorSessionHeaders", () => {
  it.each(["opencode", "opencode-go"])("adds x-opencode-session for %s, which pi-ai never sends", (provider) => {
    expect(vendorSessionHeaders(provider, "s-1")).toEqual({ "x-opencode-session": "s-1" });
  });

  it("adds x-session-id for openrouter, whose format pi-ai has but never enables", () => {
    expect(vendorSessionHeaders("openrouter", "s-1")).toEqual({ "x-session-id": "s-1" });
  });

  /**
   * Absent for two different reasons, recorded separately so a later reader
   * does not generalise the wrong one.
   *
   * `openai` (openai-responses) and `openai-codex` (openai-codex-responses)
   * reach the wire through APIs that do NOT consult
   * `compat.sendSessionAffinityHeaders`: openai-responses sets `session_id` and
   * `x-client-request-id` on any truthy id, and codex's `buildSSEHeaders` sets
   * `session-id` and `x-client-request-id` the same way. Adding either here
   * would duplicate a header pi-ai already sends. (openai verified with a stub
   * fetch; codex is a code read — pi refuses to build the request without real
   * OAuth, so no wire capture backs it.)
   */
  it.each(["openai", "openai-codex"])("adds nothing for %s, whose header pi-ai sends ungated", (provider) => {
    expect(vendorSessionHeaders(provider, "s-1")).toBeUndefined();
  });

  /**
   * `minimax`/`minimax-cn`, `vercel-ai-gateway` and `anthropic` itself (all
   * anthropic-messages) ARE behind the gate, so pi-ai sends them nothing — and
   * that is correct. None documents a session or affinity header. MiniMax's
   * Anthropic-compatible endpoint caches through explicit `cache_control`,
   * exactly as Anthropic does, and that reaches the wire unaffected by any of
   * this (verified with a stub fetch on MiniMax-M2.7 and on a Vercel gateway
   * model). Vercel's own routing and cache controls — `order`, `sort`,
   * `caching`, `cache_ttl`, `cache_anchor_items`, `byok` — are body fields
   * under `providerOptions.gateway`, not headers, so no header-shaped seam
   * reaches them and none of them is a session key. A table entry for any of
   * these would be an invented header, which is the one thing a vendor table
   * must not hold.
   */
  it.each(["minimax", "minimax-cn", "vercel-ai-gateway", "anthropic", "deepseek"])(
    "adds nothing for %s, which documents no session header to send",
    (provider) => {
      expect(vendorSessionHeaders(provider, "s-1")).toBeUndefined();
    },
  );

  it("adds nothing when there is no session id", () => {
    expect(vendorSessionHeaders("opencode-go", undefined)).toBeUndefined();
  });
});

describe("createPiDeps session wiring", () => {
  it("passes the session id through to pi", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("deepseek-v4-flash", "opencode-go");

    for await (const _ of deps.stream(model, { messages: [] }, { sessionId: "s-1" }, () => {})) {
      // drain
    }

    expect(seen?.sessionId).toBe("s-1");
  });

  it("adds the opencode header alongside it, since pi-ai has none", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("deepseek-v4-flash", "opencode-go");

    for await (const _ of deps.stream(model, { messages: [] }, { sessionId: "s-1" }, () => {})) {
      // drain
    }

    expect(seen?.headers).toMatchObject({ "x-opencode-session": "s-1" });
  });

  /**
   * The regression this pair exists for.
   *
   * pi-ai reads `x-session-id` out of a per-model `sessionAffinityFormat` of
   * "openrouter" (dist/api/openai-completions.js), but the branch is guarded by
   * `compat.sendSessionAffinityHeaders`, which `detectCompat` sets to false and
   * which not one of the 333 openrouter catalog entries overrides. So the id
   * was computed, validated and forwarded, then dropped a layer above the
   * socket: every OpenRouter generation record came back with `session_id:
   * null` and no sticky routing, and therefore no warm provider cache.
   * `ProviderOverride` deliberately exposes no `compat`, so the vendor table is
   * the only lever this package has.
   */
  it("adds x-session-id for openrouter, which pi-ai derives but never enables", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("z-ai/glm-5.3", "openrouter");

    for await (const _ of deps.stream(model, { messages: [] }, { sessionId: "s-1" }, () => {})) {
      // drain
    }

    expect(seen?.headers).toMatchObject({ "x-session-id": "s-1" });
    // Still forwarded as an option too: that is what keys pi-ai's prompt cache,
    // and it is what pi would use if a future version flipped the gate.
    expect(seen?.sessionId).toBe("s-1");
  });

  it("leaves a non-opencode provider's headers alone", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("gpt-5.4", "openai-codex");

    for await (const _ of deps.stream(model, { messages: [] }, { sessionId: "s-1" }, () => {})) {
      // drain
    }

    expect(seen?.headers?.["x-opencode-session"]).toBeUndefined();
    expect(seen?.sessionId).toBe("s-1");
  });
});

describe("vendorSessionHeaders edge cases", () => {
  it("treats an empty id as absent", () => {
    expect(vendorSessionHeaders("opencode-go", "")).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "toString"])("does not resolve %s off the prototype", (provider) => {
    expect(vendorSessionHeaders(provider, "s-1")).toBeUndefined();
  });
});

describe("header precedence against the vendor header", () => {
  it("lets an explicit request header override the vendor spelling", async () => {
    let seen: SimpleStreamOptions | undefined;
    const deps = createPiDeps({}, (_m, _c, options) => {
      seen = options;
      return emptyStream();
    });
    const model = await deps.resolveModel("deepseek-v4-flash", "opencode-go");

    for await (const _ of deps.stream(
      model,
      { messages: [] },
      { sessionId: "s-1", headers: { "x-opencode-session": "explicit" } },
      () => {},
    )) {
      // drain
    }

    expect(seen?.headers?.["x-opencode-session"]).toBe("explicit");
  });
});

/**
 * The gap the vendor-header check hides.
 *
 * `assertValidHeaders` sees the session id only once `vendorSessionHeaders` has
 * embedded it, which happens for opencode alone. Every other provider carries
 * it in `options.sessionId`, where pi-ai turns it into `x-session-id`,
 * `session_id`, `x-client-request-id` or `x-session-affinity` — so validating
 * the header map alone leaves the id unchecked exactly where it does the most
 * work.
 */
describe("session id validation at the wire", () => {
  const badId = "s-1\r\nx-injected: 1";

  async function drain(provider: string, model: string, sessionId: string) {
    const deps = createPiDeps({}, () => emptyStream());
    const resolved = await deps.resolveModel(model, provider);
    for await (const _ of deps.stream(resolved, { messages: [] }, { sessionId }, () => {})) {
      // drain
    }
  }

  it("rejects a spliceable id for a non-opencode provider, which no header check covers", async () => {
    await expect(drain("openai-codex", "gpt-5.4", badId)).rejects.toThrow(/sessionId/);
  });

  it("rejects it for an opencode provider too", async () => {
    await expect(drain("opencode-go", "deepseek-v4-flash", badId)).rejects.toThrow();
  });

  it("still accepts an ordinary id", async () => {
    await expect(drain("openai-codex", "gpt-5.4", "s-1")).resolves.toBeUndefined();
  });
});
