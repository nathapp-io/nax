import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { normaliseCatalog } from "../../src/providers/catalog.ts";
import { piProviders } from "../../src/providers/pi-catalog.ts";

describe("piProviders", () => {
  it("returns only the requested providers", async () => {
    const providers = await piProviders(["deepseek", "groq"]);
    expect(providers.map((p) => p.id).sort((a, b) => a.localeCompare(b))).toEqual(["deepseek", "groq"]);
  });

  it("throws on an unknown id rather than silently returning fewer", async () => {
    await expect(piProviders(["deepseek", "nope-xyz"])).rejects.toThrow(/nope-xyz/);
  });

  it("carries model metadata through into our own shape", async () => {
    const [deepseek] = await piProviders(["deepseek"]);
    const model = deepseek?.models.find((m) => m.id.startsWith("deepseek"));
    expect(model).toMatchObject({
      protocol: "openai-completions",
      supportsTools: expect.any(Boolean),
      contextWindow: expect.any(Number),
      pricing: { input: expect.any(Number), output: expect.any(Number) },
    });
    expect(deepseek?.baseUrl).toMatch(/^https:\/\//);
  });

  it("carries every bundled model's output ceiling", async () => {
    const [deepseek] = await piProviders(["deepseek"]);
    const models = deepseek?.models ?? [];
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(model.maxTokens).toBeGreaterThan(0);
    }
  });

  it("preserves tiered pricing for the models that have it", async () => {
    const [openai] = await piProviders(["openai"]);
    const tiered = openai?.models.filter((m) => m.pricing.tiers !== undefined) ?? [];
    expect(tiered.length).toBeGreaterThan(0);
    for (const model of tiered) {
      for (const tier of model.pricing.tiers ?? []) {
        expect(tier.inputTokensAbove).toBeGreaterThan(0);
      }
    }
  });

  it("selects api-key for a provider that offers both, so the OAuth gate cannot lock it out", async () => {
    const [anthropic] = await piProviders(["anthropic"]);
    expect(anthropic?.auth).toEqual({ kind: "api-key" });
    expect(() => normaliseCatalog(anthropic ? [anthropic] : [])).not.toThrow();
  });

  it("selects oauth for a provider that offers only oauth", async () => {
    const [codex] = await piProviders(["openai-codex"]);
    expect(codex?.auth).toEqual({ kind: "oauth", flow: "openai-codex" });
  });

  it("loads every built-in provider without tripping the OAuth allowlist", async () => {
    const providers = await piProviders();
    expect(providers.length).toBeGreaterThan(30);
    expect(() => normaliseCatalog(providers)).not.toThrow();
  });

  it("still rejects a hand-declared prohibited flow", () => {
    expect(() =>
      normaliseCatalog([
        {
          id: "anthropic",
          baseUrl: "https://api.anthropic.com",
          auth: { kind: "oauth", flow: "anthropic" },
          defaultProtocol: "anthropic-messages",
          models: [],
        },
      ]),
    ).toThrow(/prohibited/);
  });

  it("reports thinking levels for a reasoning model and none for a plain one", async () => {
    const [anthropic] = await piProviders(["anthropic"]);
    const levels = anthropic?.models.flatMap((m) => m.thinkingLevels) ?? [];
    expect(levels.length).toBeGreaterThan(0);
    for (const level of levels) {
      expect(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).toContain(level);
    }
  });

  it("projects Anthropic Messages strict-tool metadata from supportsStrictTools", async () => {
    const upstream = getBuiltinModels("anthropic");
    const source = upstream.find(
      (model) => model.api === "anthropic-messages" && model.compat?.supportsStrictTools !== undefined,
    );
    expect(source).toBeDefined();

    const [anthropic] = await piProviders(["anthropic"]);
    const projected = anthropic?.models.find((model) => model.id === source?.id);
    expect(projected?.supportsStrictToolSampling).toBe(source?.compat?.supportsStrictTools);
  });

  it("projects non-Anthropic strict-tool metadata from supportsStrictMode", async () => {
    const upstream = getBuiltinModels("openai") as ReadonlyArray<{
      readonly id: string;
      readonly api: string;
      readonly compat?: { readonly supportsStrictMode?: boolean };
    }>;
    const source = upstream.find(
      (model) => model.api !== "anthropic-messages" && model.compat?.supportsStrictMode !== undefined,
    );
    expect(source).toBeDefined();

    const [openai] = await piProviders(["openai"]);
    const projected = openai?.models.find((model) => model.id === source?.id);
    expect(projected?.supportsStrictToolSampling).toBe(source?.compat?.supportsStrictMode);
  });

  it("does not invent a strict-tool declaration when pi exposes none", async () => {
    // The provider is searched for rather than named. Pinning one (deepseek,
    // until 0.87.0 gave every model a supportsStrictMode) makes this test
    // fail the day upstream fills that provider in, which is churn in the
    // catalog rather than a regression in the projection under test.
    const candidates = ["deepseek", "groq", "mistral", "cerebras", "xai", "together", "minimax"] as const;
    let source: { readonly id: string } | undefined;
    let providerId: (typeof candidates)[number] | undefined;
    for (const id of candidates) {
      // Cast for the same reason the sibling test above casts: across a union
      // of provider ids, `compat` resolves to an intersection TS narrows to
      // `never`. Only the one flag is read.
      const upstream = getBuiltinModels(id) as ReadonlyArray<{
        readonly id: string;
        readonly api: string;
        readonly compat?: { readonly supportsStrictMode?: boolean; readonly supportsStrictTools?: boolean };
      }>;
      // Mirrors explicitStrictToolSamplingDeclaration: the anthropic-messages
      // branch reads a different flag. Filtering on supportsStrictMode alone
      // would select an anthropic-messages model that DOES declare
      // supportsStrictTools, and the projection would correctly emit the
      // property this test asserts is absent — a false failure.
      source = upstream.find(
        (model) =>
          (model.api === "anthropic-messages"
            ? model.compat?.supportsStrictTools
            : model.compat?.supportsStrictMode) === undefined,
      );
      if (source !== undefined) {
        providerId = id;
        break;
      }
    }
    expect(source, `no bundled provider in ${candidates.join(", ")} omits supportsStrictMode`).toBeDefined();

    const [provider] = await piProviders([providerId as (typeof candidates)[number]]);
    const projected = provider?.models.find((model) => model.id === source?.id);
    // Without this, a lookup miss would make the assertion below pass against
    // `undefined` and prove nothing. The provider is chosen dynamically now,
    // which is exactly what makes a miss plausible later.
    expect(projected, `projection dropped ${providerId}/${source?.id}`).toBeDefined();
    expect(projected).not.toHaveProperty("supportsStrictToolSampling");
  });
});
