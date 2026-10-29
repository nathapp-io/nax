import { describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { chatEffortLevels, chatModelChoices, tierModels } from "@/chat/chat-models";

function config(supportsTools = true) {
  return makeNaxConfig({
    models: { native: { fast: "p1/m1", balanced: "p1/m1", powerful: "p1/m1" } },
    agent: {
      native: {
        catalogOverrides: [
          {
            provider: "local",
            models: [
              {
                id: "x",
                supportsTools,
                protocol: "openai-completions",
                contextWindow: 1000,
                thinkingLevels: [],
                pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        ],
      },
    },
  });
}
describe("chatEffortLevels", () => {
  test("US-001 AC-16 keys catalog levels by base model and deduplicates lookups", async () => {
    const lookupThinkingLevels = mock(async () => ["low", "max"] as const);
    const levels = await chatEffortLevels({ config: config(), models: ["p/m[high]", "p/m"], lookupThinkingLevels });
    expect([...levels]).toEqual([["p/m", ["default", "low", "max"]]]);
    expect(lookupThinkingLevels).toHaveBeenCalledTimes(1);
    expect(lookupThinkingLevels).toHaveBeenCalledWith("p", "m");
  });
  test("US-001 AC-17 override levels win over catalog levels", async () => {
    const value = config();
    const provider = value.agent.native.catalogOverrides?.[0];
    if (!provider) throw new Error("missing fixture override");
    provider.provider = "p";
    const model = provider.models[0];
    if (!model) throw new Error("missing fixture model");
    model.id = "m";
    model.thinkingLevels = ["high"];
    const levels = await chatEffortLevels({
      config: value,
      models: ["p/m"],
      lookupThinkingLevels: async () => ["low"],
    });
    expect(levels.get("p/m")).toEqual(["default", "high"]);
  });
  test("omits unknown declarations and keeps explicit empty overrides", async () => {
    const levels = await chatEffortLevels({
      config: config(),
      models: ["local/x", "p/unknown", "bare"],
      lookupThinkingLevels: async () => undefined,
    });
    expect([...levels]).toEqual([["local/x", ["default"]]]);
  });
});

describe("tierModels", () => {
  test("AC-5 formats tiers in order and deduplicates", () => {
    const value = config();
    value.models.native = { fast: "p1/m1", balanced: "p1/m1", powerful: "p2/m2" };
    expect(tierModels(value)).toEqual(["p1/m1", "p2/m2"]);
  });
});
describe("chatModelChoices", () => {
  test("AC-6/8/9 tiers then overrides then catalog, first occurrence wins", async () => {
    const availableProviders = ["p1"];
    const listCatalogModels = mock(async (_ids: readonly string[]) => ["p1/m1", "p1/m3"]);
    expect(await chatModelChoices({ config: config(), availableProviders, listCatalogModels })).toEqual([
      "p1/m1",
      "local/x",
      "p1/m3",
    ]);
    expect(listCatalogModels).toHaveBeenCalledWith(availableProviders);
    expect(listCatalogModels.mock.calls[0]?.[0]).toBe(availableProviders);
  });
  test("AC-7 excludes non-tool overrides", async () => {
    expect(
      await chatModelChoices({ config: config(false), availableProviders: [], listCatalogModels: async () => [] }),
    ).toEqual(["p1/m1"]);
  });
  test("AC-10/17 keeps tiers and local override on catalog rejection", async () => {
    expect(
      await chatModelChoices({
        config: config(),
        availableProviders: [],
        listCatalogModels: async () => {
          throw new Error("offline");
        },
      }),
    ).toEqual(["p1/m1", "local/x"]);
  });
});
