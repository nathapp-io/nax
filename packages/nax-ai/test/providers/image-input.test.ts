import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { createClient } from "../../src/client.ts";
import { createPiDeps, createPiProtocol } from "../../src/protocols/pi-client.ts";
import { normaliseCatalog, type RawModel, type RawProvider } from "../../src/providers/catalog.ts";
import { defaultProviders } from "../../src/providers/pi-catalog.ts";
import type { ProviderOverride, ResolvedModel } from "../../src/providers/types.ts";

const RAW: RawModel = {
  id: "test",
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
  supportsTools: true,
  thinkingLevels: [],
};
const PROVIDER: RawProvider = {
  id: "custom",
  baseUrl: "https://example.invalid",
  auth: { kind: "api-key" },
  defaultProtocol: "openai-completions",
  models: [RAW],
};
const MODEL: ResolvedModel = { ...RAW, provider: "custom", protocol: "openai-completions" };

describe("normaliseCatalog image input", () => {
  it("AC-7 copies raw input", () => {
    const raw = { ...PROVIDER, models: [{ ...RAW, input: ["text", "image"] as const }] };
    expect(normaliseCatalog([raw]).model("custom", "test")).toHaveProperty("input", ["text", "image"]);
  });
  it("AC-8 leaves unknown input absent", () => {
    expect(normaliseCatalog([PROVIDER]).model("custom", "test")).not.toHaveProperty("input");
  });
  it.each([
    ["AC-9 inherits replaced input", MODEL, ["text", "image"]],
    ["AC-10 explicit input wins", { ...MODEL, input: ["text"] as const }, ["text"]],
  ] as const)("%s", (_name, model, expected) => {
    const raw = { ...PROVIDER, models: [{ ...RAW, input: ["text", "image"] as const }] };
    const catalog = normaliseCatalog([raw], [{ provider: "custom", models: [model] }]);
    expect(catalog.model("custom", "test")).toHaveProperty("input", expected);
  });
  it("new override ids do not inherit a sibling's input", () => {
    const catalog = normaliseCatalog([PROVIDER], [{ provider: "custom", models: [{ ...MODEL, id: "new" }] }]);
    expect(catalog.model("custom", "new")).not.toHaveProperty("input");
  });
});

describe("defaultProviders image input", () => {
  it("AC-11 copies every bundled model's input through resolution", async () => {
    const providers = await defaultProviders();
    const catalog = normaliseCatalog(providers);
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      const upstream = getBuiltinModels(provider.id as Parameters<typeof getBuiltinModels>[0]);
      expect(upstream.length).toBeGreaterThan(0);
      for (const model of upstream) {
        expect(catalog.model(provider.id, model.id), `${provider.id}/${model.id}`).toHaveProperty("input", model.input);
      }
    }
  });
});

async function wireModel(override: ProviderOverride, model: ResolvedModel): Promise<Model<Api>> {
  let captured: Model<Api> | undefined;
  const deps = createPiDeps({ providerOverrides: [override] }, (piModel) => {
    captured = piModel;
    return (async function* (): AsyncGenerator<AssistantMessageEvent> {})();
  });
  const client = createClient({
    providers: [],
    providerOverrides: [override],
    protocols: { [model.protocol]: { pi: async () => createPiProtocol(model.protocol, deps) } },
  });
  const resolved = await client.model(model.provider, model.id);
  for await (const _event of client.stream(resolved, { messages: [{ role: "user", content: "hi" }] })) {
    // Drain the scripted stream to observe the model at the pi boundary.
  }
  expect(captured).toBeDefined();
  if (captured === undefined) throw new Error("pi stream was not called");
  return captured;
}

describe("override pi model image input", () => {
  it.each([
    ["AC-12 introduced declared input", { ...MODEL, input: ["text", "image"] as const }, ["text", "image"]],
    ["AC-13 introduced default input", MODEL, ["text"]],
  ] as const)("%s", async (_name, model, expected) => {
    const wire = await wireModel({ provider: "custom", baseUrl: PROVIDER.baseUrl, models: [model] }, model);
    expect(wire.input).toEqual(expected);
  });
  it.each([
    ["AC-14 bundled declared input", ["text"]],
    ["AC-15 bundled inherited input", undefined],
  ] as const)("%s", async (_name, input) => {
    const template = getBuiltinModels("openai").find((model) => model.input.includes("image"));
    expect(template).toBeDefined();
    if (template === undefined) throw new Error("missing image template");
    const model: ResolvedModel = {
      ...MODEL,
      provider: "openai",
      id: template.id,
      protocol: template.api,
      ...(input !== undefined ? { input } : {}),
    };
    const wire = await wireModel({ provider: "openai", models: [model] }, model);
    expect(wire.input).toEqual(input ?? template.input);
  });
});
