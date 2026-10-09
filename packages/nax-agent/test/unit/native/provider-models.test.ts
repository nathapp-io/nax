import { afterEach, describe, expect, test } from "bun:test";
import { _clientDeps, _resetNativeClient, listProviderModels } from "@nathapp/nax-agent/internal";
import type { Client, ResolvedModel } from "@nathapp/nax-ai";

const REAL_BUILD = _clientDeps.build;
afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

function model(id: string, extra: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    id,
    provider: "acme",
    protocol: "openai-completions",
    pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    supportsTools: true,
    thinkingLevels: [],
    ...extra,
  };
}

function clientListing(models: readonly ResolvedModel[], asked: (string | undefined)[]): Client {
  return {
    model: async () => {
      throw new Error("unused");
    },
    listModels: async (provider) => {
      asked.push(provider);
      return models;
    },
    pricing: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
    stream: async function* () {},
    complete: async () => ({ text: "", usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "stop" }),
    validate: () => {},
  };
}

describe("listProviderModels", () => {
  test("returns plain id and window data for the provider, sorted by id, tool-capable models only", async () => {
    const asked: (string | undefined)[] = [];
    _clientDeps.build = async () =>
      clientListing(
        [model("zeta", { maxTokens: 8000 }), model("alpha"), model("no-tools", { supportsTools: false })],
        asked,
      );
    expect(await listProviderModels("acme")).toEqual([
      { id: "alpha", contextWindow: 100_000 },
      { id: "zeta", contextWindow: 100_000, maxTokens: 8000 },
    ]);
    expect(asked).toEqual(["acme"]);
  });

  test("an unknown provider lists nothing", async () => {
    _clientDeps.build = async () => clientListing([], []);
    expect(await listProviderModels("nope")).toEqual([]);
  });

  test("a catalog that fails to load rejects", async () => {
    _clientDeps.build = async () => {
      throw new Error("catalog unavailable");
    };
    await expect(listProviderModels("acme")).rejects.toThrow("catalog unavailable");
  });
});
