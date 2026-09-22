/**
 * The catalog diff is the bump-review tool, so its own failure mode is a
 * missed change reported as "nothing to see". Every test here asserts that a
 * specific class of change is SEEN, not merely that the differ runs.
 */

import { describe, expect, it } from "vitest";
import { type Catalog, diffCatalogs, filterCatalog, formatDiff, hasChanges } from "../scripts/catalog-diff-core.ts";

const model = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "m",
  name: "M",
  api: "openai-completions",
  provider: "p",
  baseUrl: "https://example.invalid",
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 1000,
  maxTokens: 100,
  ...over,
});

const catalog = (entry: Record<string, unknown> = model()): Catalog => ({
  p: { "openai-completions": { m: entry } },
});

describe("diffCatalogs", () => {
  it("reports nothing when the two catalogs are identical", () => {
    const d = diffCatalogs(catalog(), catalog());
    expect(hasChanges(d)).toBe(false);
  });

  it("reports an added provider", () => {
    const after: Catalog = { ...catalog(), q: { "openai-completions": { x: model({ provider: "q", id: "x" }) } } };
    const d = diffCatalogs(catalog(), after);
    expect(d.providersAdded).toEqual(["q"]);
    expect(d.providersRemoved).toEqual([]);
  });

  it("reports a removed provider", () => {
    const before: Catalog = { ...catalog(), q: { "openai-completions": { x: model({ provider: "q", id: "x" }) } } };
    const d = diffCatalogs(before, catalog());
    expect(d.providersRemoved).toEqual(["q"]);
  });

  it("reports an added and a removed model", () => {
    const after: Catalog = { p: { "openai-completions": { n: model({ id: "n" }) } } };
    const d = diffCatalogs(catalog(), after);
    expect(d.modelsAdded).toEqual([{ provider: "p", api: "openai-completions", id: "n" }]);
    expect(d.modelsRemoved).toEqual([{ provider: "p", api: "openai-completions", id: "m" }]);
  });

  it("reports each cost component separately, so a cacheRead change is not hidden by an unchanged input rate", () => {
    const d = diffCatalogs(catalog(), catalog(model({ cost: { input: 1, output: 2, cacheRead: 9, cacheWrite: 0.2 } })));
    expect(d.modelsChanged).toHaveLength(1);
    expect(d.modelsChanged[0]?.changes).toEqual([{ field: "cost.cacheRead", before: 0.1, after: 9 }]);
  });

  it("reports a context window change", () => {
    const d = diffCatalogs(catalog(), catalog(model({ contextWindow: 2000 })));
    expect(d.modelsChanged[0]?.changes).toEqual([{ field: "contextWindow", before: 1000, after: 2000 }]);
  });

  it("reports a maxTokens change — the field that silently rewrote an override model in #39", () => {
    const d = diffCatalogs(catalog(), catalog(model({ maxTokens: 64 })));
    expect(d.modelsChanged[0]?.changes).toEqual([{ field: "maxTokens", before: 100, after: 64 }]);
  });

  it("reports a wire-format change as a reroute rather than an add plus a remove", () => {
    const after: Catalog = { p: { "anthropic-messages": { m: model({ api: "anthropic-messages" }) } } };
    const d = diffCatalogs(catalog(), after);
    expect(d.modelsAdded).toEqual([]);
    expect(d.modelsRemoved).toEqual([]);
    expect(d.modelsChanged[0]?.changes).toEqual([
      { field: "api", before: "openai-completions", after: "anthropic-messages" },
    ]);
  });

  it("reports a baseUrl change, which redirects traffic without changing any other field", () => {
    const d = diffCatalogs(catalog(), catalog(model({ baseUrl: "https://elsewhere.invalid" })));
    expect(d.modelsChanged[0]?.changes).toEqual([
      { field: "baseUrl", before: "https://example.invalid", after: "https://elsewhere.invalid" },
    ]);
  });

  it("distinguishes an absent thinkingLevelMap key from one explicitly set to null", () => {
    // thinkingLevelMap.off is three-state: absent, null, and a value each mean
    // something different. A differ that coerces the first two together would
    // report no change here.
    const before = catalog(model({ thinkingLevelMap: { off: null, low: "low" } }));
    const after = catalog(model({ thinkingLevelMap: { low: "low" } }));
    const d = diffCatalogs(before, after);
    expect(d.modelsChanged[0]?.changes).toEqual([
      { field: "thinkingLevelMap", before: { off: null, low: "low" }, after: { low: "low" } },
    ]);
  });

  it("treats a thinkingLevelMap whose keys are reordered as unchanged", () => {
    const before = catalog(model({ thinkingLevelMap: { off: null, low: "low" } }));
    const after = catalog(model({ thinkingLevelMap: { low: "low", off: null } }));
    expect(hasChanges(diffCatalogs(before, after))).toBe(false);
  });

  it("reports a compat flag change — the class that swallowed the session id", () => {
    const before = catalog(model({ compat: { sendSessionAffinityHeaders: true } }));
    const after = catalog(model({ compat: { sendSessionAffinityHeaders: false } }));
    const d = diffCatalogs(before, after);
    expect(d.modelsChanged[0]?.changes).toEqual([
      {
        field: "compat",
        before: { sendSessionAffinityHeaders: true },
        after: { sendSessionAffinityHeaders: false },
      },
    ]);
  });

  it("reports a compat block that appears where there was none", () => {
    const d = diffCatalogs(catalog(), catalog(model({ compat: { supportsTemperature: false } })));
    expect(d.modelsChanged[0]?.changes).toEqual([
      { field: "compat", before: undefined, after: { supportsTemperature: false } },
    ]);
  });

  it("reports a headers change, which rewrites what is sent on every request to that provider", () => {
    // 48 models carry `headers`, and pi-catalog.ts lifts it onto RawProvider.
    // github-copilot gates access on Editor-Version / Copilot-Integration-Id,
    // so a bump that revs them is exactly what this tool must surface.
    const before = catalog(model({ headers: { "User-Agent": "GitHubCopilotChat/0.35.0" } }));
    const after = catalog(model({ headers: { "User-Agent": "GitHubCopilotChat/0.99.0" } }));
    const d = diffCatalogs(before, after);
    expect(d.modelsChanged[0]?.changes).toEqual([
      {
        field: "headers",
        before: { "User-Agent": "GitHubCopilotChat/0.35.0" },
        after: { "User-Agent": "GitHubCopilotChat/0.99.0" },
      },
    ]);
  });

  it("reports headers disappearing entirely", () => {
    const before = catalog(model({ headers: { "User-Agent": "x" } }));
    const d = diffCatalogs(before, catalog());
    expect(d.modelsChanged[0]?.changes).toEqual([
      { field: "headers", before: { "User-Agent": "x" }, after: undefined },
    ]);
  });

  it("reports a cost.tiers rewrite, which reprices above a threshold without touching a flat rate", () => {
    const before = catalog(model({ cost: { input: 1, output: 2, tiers: [{ inputTokensAbove: 272000, input: 0.4 }] } }));
    const after = catalog(model({ cost: { input: 1, output: 2, tiers: [{ inputTokensAbove: 128000, input: 9.9 }] } }));
    const d = diffCatalogs(before, after);
    expect(d.modelsChanged[0]?.changes).toEqual([
      {
        field: "cost.tiers",
        before: [{ inputTokensAbove: 272000, input: 0.4 }],
        after: [{ inputTokensAbove: 128000, input: 9.9 }],
      },
    ]);
  });

  it("reports an inserted cost tier rather than misaligning the comparison by index", () => {
    const before = catalog(model({ cost: { input: 1, output: 2, tiers: [{ inputTokensAbove: 200, input: 5 }] } }));
    const after = catalog(
      model({
        cost: {
          input: 1,
          output: 2,
          tiers: [
            { inputTokensAbove: 100, input: 3 },
            { inputTokensAbove: 200, input: 5 },
          ],
        },
      }),
    );
    expect(diffCatalogs(before, after).modelsChanged[0]?.changes).toHaveLength(1);
  });

  it("reports a model id served under two wire formats as a collision rather than silently dropping one", () => {
    // The (provider, id) keying assumes no provider serves one id under two
    // apis — true across all 1,393 entries today. If it ever stops being true,
    // the differ must say so rather than let one entry shadow the other.
    const before: Catalog = {
      p: {
        "openai-completions": { m: model({ maxTokens: 100 }) },
        "anthropic-messages": { m: model({ maxTokens: 500 }) },
      },
    };
    expect(diffCatalogs(before, before).collisions).toEqual([
      { provider: "p", id: "m", apis: ["anthropic-messages", "openai-completions"] },
    ]);
    expect(hasChanges(diffCatalogs(before, before))).toBe(true);
  });

  it("does not fabricate a reroute when the upstream file merely reorders its api keys", () => {
    const before: Catalog = {
      p: { A: { m: model({ api: "A", maxTokens: 100 }) }, B: { m: model({ api: "B", maxTokens: 500 }) } },
    };
    const after: Catalog = {
      p: { B: { m: model({ api: "B", maxTokens: 500 }) }, A: { m: model({ api: "A", maxTokens: 100 }) } },
    };
    // Identical data, different key order. A differ that let file order pick
    // the winner would report a reroute A -> B and a maxTokens change.
    expect(diffCatalogs(before, after).modelsChanged).toEqual([]);
  });

  it("ignores a display-name change, which cannot affect a request", () => {
    expect(hasChanges(diffCatalogs(catalog(), catalog(model({ name: "Different" }))))).toBe(false);
  });

  it("reports several changed fields on one model as one entry", () => {
    const d = diffCatalogs(catalog(), catalog(model({ contextWindow: 5, maxTokens: 6 })));
    expect(d.modelsChanged).toHaveLength(1);
    expect(d.modelsChanged[0]?.changes).toHaveLength(2);
  });
});

describe("filterCatalog", () => {
  const two: Catalog = {
    p: { "openai-completions": { m: model() } },
    q: { "openai-completions": { x: model({ provider: "q", id: "x" }) } },
  };

  it("keeps only the named providers", () => {
    expect(Object.keys(filterCatalog(two, ["q"]))).toEqual(["q"]);
  });

  it("returns the catalog untouched when no providers are named", () => {
    expect(filterCatalog(two, [])).toBe(two);
  });

  it("ignores a name that is not in this catalog, so a provider added later does not throw", () => {
    expect(Object.keys(filterCatalog(two, ["q", "absent"]))).toEqual(["q"]);
  });

  it("filtering to an untouched provider hides a change in another one", () => {
    const after: Catalog = { ...two, p: { "openai-completions": { m: model({ maxTokens: 1 }) } } };
    expect(hasChanges(diffCatalogs(two, after))).toBe(true);
    expect(hasChanges(diffCatalogs(filterCatalog(two, ["q"]), filterCatalog(after, ["q"])))).toBe(false);
  });
});

describe("formatDiff", () => {
  it("says so explicitly when nothing changed, rather than printing an empty report", () => {
    expect(formatDiff(diffCatalogs(catalog(), catalog()))).toMatch(/no catalog changes/i);
  });

  it("names the provider, the model and both values of a changed field", () => {
    const out = formatDiff(diffCatalogs(catalog(), catalog(model({ maxTokens: 64 }))));
    expect(out).toContain("p");
    expect(out).toContain("m");
    expect(out).toContain("maxTokens");
    expect(out).toContain("100");
    expect(out).toContain("64");
  });

  it("puts a wire-format reroute under its own heading so it cannot be read as a price change", () => {
    const after: Catalog = { p: { "anthropic-messages": { m: model({ api: "anthropic-messages" }) } } };
    expect(formatDiff(diffCatalogs(catalog(), after))).toMatch(/reroute/i);
  });
});
