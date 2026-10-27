import { describe, expect, mock, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { chatModelChoices, tierModels } from "@/chat/chat-models";

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
