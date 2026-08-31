import { describe, expect, it } from "vitest";
import { OAuthFlowProhibitedError } from "../../src/auth/oauth-policy.ts";
import { normaliseCatalog, type RawProvider } from "../../src/providers/catalog.ts";

const DEEPSEEK: RawProvider = {
  id: "deepseek",
  baseUrl: "https://api.deepseek.com",
  auth: { kind: "api-key", env: "DEEPSEEK_API_KEY" },
  defaultProtocol: "openai-completions",
  models: [
    {
      id: "deepseek-chat",
      pricing: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0 },
      contextWindow: 64000,
      supportsTools: true,
      thinkingLevels: [],
    },
  ],
};

const RAW: readonly RawProvider[] = [
  DEEPSEEK,
  {
    id: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    auth: { kind: "api-key", env: "OPENCODE_API_KEY" },
    defaultProtocol: "openai-completions",
    models: [
      {
        id: "a",
        pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100,
        supportsTools: false,
        thinkingLevels: [],
      },
      {
        id: "b",
        protocol: "anthropic-messages",
        pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100,
        supportsTools: false,
        thinkingLevels: [],
      },
    ],
  },
];

describe("normaliseCatalog", () => {
  it("gives every model the provider default protocol", () => {
    const catalog = normaliseCatalog(RAW);
    expect(catalog.model("deepseek", "deepseek-chat")?.protocol).toBe("openai-completions");
  });

  it("lets a model override the provider protocol", () => {
    // opencode-go really does serve models over three protocols.
    const catalog = normaliseCatalog(RAW);
    expect(catalog.model("opencode-go", "a")?.protocol).toBe("openai-completions");
    expect(catalog.model("opencode-go", "b")?.protocol).toBe("anthropic-messages");
  });

  it("returns undefined for an unknown model", () => {
    expect(normaliseCatalog(RAW).model("deepseek", "nope")).toBeUndefined();
  });

  it("lists models, optionally filtered by provider", () => {
    const catalog = normaliseCatalog(RAW);
    expect(catalog.listModels()).toHaveLength(3);
    expect(catalog.listModels("opencode-go")).toHaveLength(2);
  });

  it("rejects a provider declaring the prohibited anthropic OAuth flow", () => {
    // The gate on the real path, not just in a unit test of the policy module.
    const withProhibited: RawProvider[] = [{ ...DEEPSEEK, id: "sneaky", auth: { kind: "oauth", flow: "anthropic" } }];
    expect(() => normaliseCatalog(withProhibited)).toThrow(OAuthFlowProhibitedError);
  });

  it("accepts a provider declaring a permitted OAuth flow", () => {
    const withCodex: RawProvider[] = [
      { ...DEEPSEEK, id: "openai-codex", auth: { kind: "oauth", flow: "openai-codex" } },
    ];
    expect(() => normaliseCatalog(withCodex)).not.toThrow();
  });

  it("applies a baseUrl override", () => {
    const catalog = normaliseCatalog(RAW, [{ provider: "deepseek", baseUrl: "https://proxy.local" }]);
    expect(catalog.provider("deepseek")?.baseUrl).toBe("https://proxy.local");
  });

  it("adds models supplied by an override", () => {
    const catalog = normaliseCatalog(RAW, [
      {
        provider: "deepseek",
        models: [
          {
            id: "deepseek-new",
            provider: "deepseek",
            protocol: "openai-completions",
            pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1000,
            supportsTools: true,
            thinkingLevels: [],
          },
        ],
      },
    ]);
    expect(catalog.model("deepseek", "deepseek-new")).toBeDefined();
  });

  it("replaces an existing model when the override supplies the same id", () => {
    // "deepseek-chat" already exists in the raw catalog; the override entry
    // with the same id must win, not be appended alongside it.
    const catalog = normaliseCatalog(RAW, [
      {
        provider: "deepseek",
        models: [
          {
            id: "deepseek-chat",
            provider: "deepseek",
            protocol: "openai-completions",
            pricing: { input: 3, output: 15, cacheRead: 0.1, cacheWrite: 0 },
            contextWindow: 131072,
            supportsTools: false,
            thinkingLevels: ["off"],
          },
        ],
      },
    ]);
    const model = catalog.model("deepseek", "deepseek-chat");
    expect(model?.pricing.input).toBe(3);
    expect(model?.pricing.output).toBe(15);
    expect(model?.contextWindow).toBe(131072);
    expect(model?.supportsTools).toBe(false);
    expect(catalog.listModels()).toHaveLength(3);
  });

  it("keeps slash-containing provider and model ids distinct", () => {
    const model = {
      pricing: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1,
      supportsTools: false,
      thinkingLevels: [],
    } as const;
    const catalog = normaliseCatalog([
      { ...DEEPSEEK, id: "a", models: [{ ...model, id: "b/c" }] },
      { ...DEEPSEEK, id: "a/b", models: [{ ...model, id: "c" }] },
    ]);

    expect(catalog.model("a", "b/c")?.provider).toBe("a");
    expect(catalog.model("a/b", "c")?.provider).toBe("a/b");
    expect(catalog.listModels()).toHaveLength(2);
  });

  it("preserves tiered pricing through normalisation", () => {
    const catalog = normaliseCatalog([
      {
        id: "openai",
        baseUrl: "https://api.openai.com",
        auth: { kind: "api-key" },
        defaultProtocol: "openai-responses",
        models: [
          {
            id: "gpt-5.4",
            pricing: {
              input: 2.5,
              output: 15,
              cacheRead: 0.25,
              cacheWrite: 0,
              tiers: [{ inputTokensAbove: 272000, input: 5, output: 22.5, cacheRead: 0.5, cacheWrite: 0 }],
            },
            contextWindow: 400000,
            supportsTools: true,
            thinkingLevels: [],
          },
        ],
      },
    ]);

    const model = catalog.model("openai", "gpt-5.4");
    expect(model?.pricing.tiers).toHaveLength(1);
    expect(model?.pricing.tiers?.[0]).toEqual({
      inputTokensAbove: 272000,
      input: 5,
      output: 22.5,
      cacheRead: 0.5,
      cacheWrite: 0,
    });
  });

  it("accepts an api-key provider that declares no env var name", () => {
    const catalog = normaliseCatalog([
      {
        id: "deepseek",
        baseUrl: "https://api.deepseek.com",
        auth: { kind: "api-key" },
        defaultProtocol: "openai-completions",
        models: [],
      },
    ]);

    expect(catalog.provider("deepseek")?.auth).toEqual({ kind: "api-key" });
  });
});
