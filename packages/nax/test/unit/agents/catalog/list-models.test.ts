import { afterEach, describe, expect, mock, test } from "bun:test";
import type { RawProvider } from "@nathapp/nax-ai";
import { _catalogDeps, listCatalogModels } from "@/agents/catalog";

const originals = { ..._catalogDeps };
afterEach(() => Object.assign(_catalogDeps, originals));
function provider(id: string): RawProvider {
  return {
    id,
    baseUrl: "https://test.invalid",
    auth: { kind: "api-key" },
    defaultProtocol: "test",
    models: (id === "anthropic" ? [true, false] : [true, false, true]).map((supportsTools, index) => ({
      id: `a${index + 1}`,
      protocol: "test",
      supportsTools,
      pricing: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
      contextWindow: 1000,
      thinkingLevels: [],
    })),
  };
}
describe("listCatalogModels", () => {
  test.each([
    ["AC-1", ["anthropic"], ["anthropic/a1"]],
    ["AC-2", ["p2", "p1"], ["p2/a1", "p2/a3", "p1/a1", "p1/a3"]],
    ["AC-3", ["nope"], []],
  ] as const)("%s filters tools and preserves provider/catalog order", async (_ac, ids, expected) => {
    _catalogDeps.loadProviders = mock(async () => [provider("anthropic"), provider("p1"), provider("p2")]);
    expect(await listCatalogModels(ids)).toEqual(expected);
    expect(await listCatalogModels(ids)).toEqual(expected);
    expect(_catalogDeps.loadProviders).toHaveBeenCalledTimes(1);
  });
  test("AC-4 returns empty on load rejection", async () => {
    _catalogDeps.loadProviders = async () => {
      throw new Error("offline");
    };
    expect(await listCatalogModels(["anthropic"])).toEqual([]);
  });
});
