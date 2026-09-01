/**
 * The native adapter.
 *
 * complete() catches nax-ai's ProtocolStreamError and returns an adapterFailure
 * rather than rethrowing: rethrowing would route through
 * classifyCompleteException -> parseAgentError, which parses ACP strings and
 * would discard the typed kind nax-ai just handed us.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";
import { _adapterDeps, NativeAgentAdapter } from "@/agents/native/adapter";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { ResolvedCompleteOptions } from "@/agents/types";

const REAL_BUILD = _clientDeps.build;
const REAL_LIST = _adapterDeps.listStoredProviders;
const REAL_SWEEP = _adapterDeps.anyAmbientCredential;

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
  _adapterDeps.listStoredProviders = REAL_LIST;
  _adapterDeps.anyAmbientCredential = REAL_SWEEP;
});

const MODEL = {
  id: "gpt-5.4-mini",
  provider: "openai",
  protocol: "openai-responses",
  pricing: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  supportsTools: true,
  thinkingLevels: [],
} satisfies ResolvedModel;

function fakeClient(over: Record<string, unknown> = {}): Client {
  return {
    model: async () => MODEL,
    listModels: async () => [MODEL],
    pricing: () => ({ input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* stream() {},
    complete: async () => ({
      text: "ok",
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      stopReason: "stop",
    }),
    validate: () => {},
    ...over,
  };
}

function options(): ResolvedCompleteOptions {
  return {
    // provider is what resolveModel() infers for this string: "unknown".
    modelDef: { provider: "unknown", model: "openai/gpt-5.4-mini" },
    workdir: process.cwd(),
    resolvedPermissions: { mode: "approve-all" },
  };
}

describe("NativeAgentAdapter.complete", () => {
  test("returns the text, mapped usage and a computed cost", async () => {
    _clientDeps.build = async () => fakeClient();
    const result = await new NativeAgentAdapter().complete("hi", options());

    expect(result.output).toBe("ok");
    expect(result.tokenUsage.inputTokens).toBe(1_000_000);
    expect(result.estimatedCostUsd).toBeCloseTo(3, 6);
    expect(result.adapterFailure).toBeUndefined();
  });

  test("ignores modelDef.provider, which resolveModel only guessed", async () => {
    // resolveModel infers "unknown" for "openai/gpt-5.4-mini" and would infer
    // "anthropic" for anything starting "claude". Neither is configuration.
    let asked: [string, string] | undefined;
    _clientDeps.build = async () =>
      fakeClient({
        model: async (p: string, m: string) => {
          asked = [p, m];
          return MODEL;
        },
      });

    const opts = options();
    (opts.modelDef as { provider: string }).provider = "unknown";
    await new NativeAgentAdapter().complete("hi", opts);

    expect(asked).toEqual(["openai", "gpt-5.4-mini"]);
  });

  test("never sets exactCostUsd, because nax-ai supplies rates and not cost", async () => {
    _clientDeps.build = async () => fakeClient();
    const result = await new NativeAgentAdapter().complete("hi", options());
    expect(result.exactCostUsd).toBeUndefined();
  });

  test("turns a rate limit into a swappable availability failure", async () => {
    class ProtocolStreamError extends Error {
      constructor(readonly protocolError: { kind: string; message: string }) {
        super(protocolError.message);
        this.name = "ProtocolStreamError";
      }
    }
    _clientDeps.build = async () =>
      fakeClient({
        complete: async () => {
          throw new ProtocolStreamError({ kind: "rate-limit", message: "429" });
        },
      });

    const result = await new NativeAgentAdapter().complete("hi", options());

    expect(result.adapterFailure?.category).toBe("availability");
    expect(result.adapterFailure?.outcome).toBe("fail-rate-limit");
    expect(result.output).toBe("");
  });
});

describe("NativeAgentAdapter shape", () => {
  test("takes its tiers from config, since native's are arbitrary names", () => {
    const adapter = new NativeAgentAdapter(["cheap", "strong"]);
    expect(adapter.capabilities.supportedTiers).toEqual(["cheap", "strong"]);
  });

  test("falls back to the builtin tiers rather than none when built without config", () => {
    // [] would make the execution stage log a tier mismatch on every story:
    // it clamps to supportedTiers[0], which would be undefined.
    expect(new NativeAgentAdapter().capabilities.supportedTiers).toEqual(["fast", "balanced", "powerful"]);
    expect(new NativeAgentAdapter([]).capabilities.supportedTiers).toHaveLength(3);
  });

  test("declares no binary and builds no command", () => {
    const adapter = new NativeAgentAdapter();
    expect(adapter.binary).toBe("");
    expect(adapter.buildCommand()).toEqual([]);
  });

  test("refuses session methods, naming the phase that adds them", async () => {
    const adapter = new NativeAgentAdapter();
    await expect(adapter.openSession()).rejects.toThrow(/Phase B/);
    await expect(adapter.sendTurn()).rejects.toThrow(/Phase B/);
  });
});

describe("isInstalled", () => {
  test("is true even when hasCredentials is false: in-process, nothing to install", async () => {
    const adapter = new NativeAgentAdapter();
    // Force the credential probe to say no. If isInstalled still delegates,
    // it returns false and this fails.
    adapter.hasCredentials = async () => false;

    expect(await adapter.isInstalled()).toBe(true);
  });
});

describe("hasCredentials", () => {
  test("is true when a credential is stored, without sweeping ambient auth", async () => {
    let swept = false;
    _adapterDeps.listStoredProviders = async () => [{ providerId: "minimax", kind: "api-key" as const }];
    _adapterDeps.anyAmbientCredential = async () => {
      swept = true;
      return false;
    };

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
    expect(swept).toBe(false);
  });

  test("falls back to the ambient sweep when nothing is stored", async () => {
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = async () => true;

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
  });

  test("is false only when nothing is stored and nothing is ambient", async () => {
    _adapterDeps.listStoredProviders = async () => [];
    _adapterDeps.anyAmbientCredential = async () => false;

    expect(await new NativeAgentAdapter().hasCredentials()).toBe(false);
  });

  test("an unreadable credential file does not prune the agent", async () => {
    _adapterDeps.listStoredProviders = async () => {
      throw new Error("EACCES");
    };
    _adapterDeps.anyAmbientCredential = async () => false;

    // Fail open: an unreadable store is "unknown", not "no credentials".
    expect(await new NativeAgentAdapter().hasCredentials()).toBe(true);
  });
});
