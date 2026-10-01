/**
 * nativeComplete: the package-side one-shot call (S1 port 2). Options are
 * package-owned: a SessionModel whose pricing is already converted.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import { nativeComplete } from "@/agents/native/complete";
import { nativeSessionId } from "@/agents/native/session-affinity";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

const CATALOG = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: CATALOG,
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

function fakeClient(complete: Client["complete"]): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => CATALOG,
    stream: async function* stream() {},
    complete,
    validate: () => {},
  };
}

const CONTEXT = { catalogOverrides: [], sessionKey: "key-1" };

describe("nativeComplete", () => {
  test("prices from the catalog when the model carries no override", async () => {
    _clientDeps.build = async () =>
      fakeClient(async () => ({ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 0 }, stopReason: "stop" }));
    const out = await nativeComplete("hi", { model: { provider: "openai", model: "openai/gpt-5.4-mini" } }, CONTEXT);
    expect(out.output).toBe("ok");
    expect(out.pricingSource).toBe("catalog-rates");
    expect(out.estimatedCostUsd).toBe(3);
    expect(out.sessionId).toBe(nativeSessionId("key-1"));
  });

  test("an explicit override wins wholesale", async () => {
    _clientDeps.build = async () =>
      fakeClient(async () => ({ text: "ok", usage: { inputTokens: 1_000_000, outputTokens: 0 }, stopReason: "stop" }));
    const pricing = { input: 7, output: 9, cacheRead: 7, cacheWrite: 7 };
    const out = await nativeComplete(
      "hi",
      { model: { provider: "openai", model: "openai/gpt-5.4-mini", pricing } },
      CONTEXT,
    );
    expect(out.pricingSource).toBe("config-override");
    expect(out.estimatedCostUsd).toBe(7);
  });

  test("a protocol fault is returned as an adapter failure with zero usage", async () => {
    _clientDeps.build = async () =>
      fakeClient(async () => {
        throw Object.assign(new Error("bad key"), { protocolError: { kind: "auth", message: "bad key" } });
      });
    const out = await nativeComplete("hi", { model: { provider: "openai", model: "openai/gpt-5.4-mini" } }, CONTEXT);
    expect(out.output).toBe("");
    expect(out.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(out.adapterFailure?.outcome).toBe("fail-auth");
  });
});
