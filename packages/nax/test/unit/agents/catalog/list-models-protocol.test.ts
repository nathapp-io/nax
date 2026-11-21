/**
 * The picker must not offer a discovered model the native client cannot run.
 *
 * `listCatalogModels` keeps a model only when the native client registers its
 * protocol (`DEFAULT_PROTOCOL_NAMES`, exactly what `buildNativeClient` wires),
 * because a model on any other protocol fails at the first request with
 * "Unknown protocol". Configured tiers and `agent.native.catalogOverrides`
 * entries are explicit local declarations and stay in the picker regardless —
 * they are not catalog discoveries, so they never pass through this filter.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { RawProvider } from "@nathapp/nax-ai";
import { makeNaxConfig } from "@test/helpers";
import { _catalogDeps, listCatalogModels } from "@/agents/catalog";
import { chatModelChoices } from "@/chat/chat-models";

const originals = { ..._catalogDeps };
afterEach(() => Object.assign(_catalogDeps, originals));

/** One fixture model: its catalog id, wire protocol and tool capability. */
interface ModelSpec {
  readonly id: string;
  readonly protocol: string;
  readonly supportsTools: boolean;
}

/** The standard p1 catalog: one registered tool model, one unregistered, one non-tool, one registered. */
const STANDARD_MODELS: readonly ModelSpec[] = [
  { id: "m1", protocol: "openai-completions", supportsTools: true },
  { id: "m2", protocol: "google-generative-ai", supportsTools: true },
  { id: "m3", protocol: "anthropic-messages", supportsTools: false },
  { id: "m4", protocol: "openai-responses", supportsTools: true },
];

function provider(models: readonly ModelSpec[]): RawProvider {
  return {
    id: "p1",
    baseUrl: "https://p1.invalid",
    auth: { kind: "api-key" },
    defaultProtocol: "openai-completions",
    models: models.map((spec) => ({
      id: spec.id,
      protocol: spec.protocol,
      supportsTools: spec.supportsTools,
      pricing: { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
      contextWindow: 1000,
      thinkingLevels: [],
    })),
  };
}

/** Stub the catalog seam; each call installs a fresh loader, so each test gets its own cache slot. */
function stubCatalog(models: readonly ModelSpec[] = STANDARD_MODELS): void {
  _catalogDeps.loadProviders = mock(async () => [provider(models)]);
}

describe("listCatalogModels protocol filter", () => {
  test("AC-1 keeps only tool models whose protocol the native client registers", async () => {
    stubCatalog();
    expect(await listCatalogModels(["p1"])).toEqual(["p1/m1", "p1/m4"]);
  });

  test("AC-2 returns empty when every model uses an unregistered protocol", async () => {
    stubCatalog(STANDARD_MODELS.map((spec) => ({ ...spec, protocol: "google-generative-ai" })));
    expect(await listCatalogModels(["p1"])).toEqual([]);
  });

  test("AC-3 control: codex-responses and anthropic-messages models are both kept, in catalog order", async () => {
    stubCatalog([
      { id: "m1", protocol: "openai-codex-responses", supportsTools: true },
      { id: "m2", protocol: "anthropic-messages", supportsTools: true },
    ]);
    expect(await listCatalogModels(["p1"])).toEqual(["p1/m1", "p1/m2"]);
  });

  test("AC-4 control: returns empty on load rejection", async () => {
    _catalogDeps.loadProviders = async () => {
      throw new Error("offline");
    };
    expect(await listCatalogModels(["p1"])).toEqual([]);
  });
});

describe("chatModelChoices with the production catalog reader", () => {
  test("AC-5 offers only runnable discovered models when nothing is declared locally", async () => {
    stubCatalog();
    const config = makeNaxConfig({ models: {} });
    // The AC's premise: no configured tiers and no local catalog overrides.
    expect(config.models.native).toBeUndefined();
    expect(config.agent?.native?.catalogOverrides).toEqual([]);
    expect(await chatModelChoices({ config, availableProviders: ["p1"], listCatalogModels })).toEqual([
      "p1/m1",
      "p1/m4",
    ]);
  });
});
