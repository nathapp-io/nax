import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { CatalogModelOverride, ProviderCatalogOverride } from "#src/config/catalog-overrides";
import { errorMessage } from "#src/infra/errors";
import { buildNativeClient } from "#src/native/client";
import { toProviderOverrides } from "#src/native/models";
import { mockFetch } from "#test/helpers/index";

function strata(thinkingBudgetField = "reasoning_budget_tokens") {
  return {
    provider: "strata",
    baseUrl: "http://127.0.0.1:18080/v1",
    authEnv: "STRATA_KEY",
    models: [
      {
        id: "qwen3.8-flash",
        protocol: "openai-completions",
        contextWindow: 131072,
        maxTokens: 32768,
        supportsTools: true,
        thinkingLevels: ["off", "low", "high"],
        pricing: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        thinkingBudgetField,
        thinkingBudgets: { low: 2048 },
      } satisfies CatalogModelOverride,
    ],
  } satisfies ProviderCatalogOverride;
}

async function dependencyBuildState() {
  const entry = import.meta.resolve("@nathapp/nax-ai");
  const paths = [
    "../package.json",
    "client.js",
    "protocols/pi-client.js",
    "../src/client.ts",
    "../src/protocols/pi-client.ts",
  ];
  const files = await Promise.all(
    paths.map(async (path) => {
      const url = new URL(path, entry);
      try {
        const [content, info] = await Promise.all([readFile(url, "utf8"), stat(url)]);
        return {
          path: url.href,
          modified: info.mtime.toISOString(),
          sha256: createHash("sha256").update(content).digest("hex"),
          referencesThinkingBudgets: content.includes("thinkingBudgets"),
        };
      } catch (error) {
        // A published dependency need not include source. Diagnostics must not
        // replace the original wire failure when a fingerprint is unavailable.
        return { path: url.href, unavailable: errorMessage(error) };
      }
    }),
  );
  return { entry, runtime: process.version, files };
}

const originalFetch = globalThis.fetch;
const originalKey = process.env.STRATA_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.STRATA_KEY;
  else process.env.STRATA_KEY = originalKey;
});

describe("toProviderOverrides thinking budgets", () => {
  test("AC-1 forwards the declared budget field", () => {
    expect(toProviderOverrides([strata()])[0]?.models?.[0]?.thinkingBudgetField).toBe("reasoning_budget_tokens");
  });

  test("AC-2 copies declared budgets without aliasing the config", () => {
    const override = strata();
    const mapped = toProviderOverrides([override])[0]?.models?.[0];
    expect(mapped?.thinkingBudgets).toEqual({ low: 2048 });
    expect(mapped?.thinkingBudgets).not.toBe(override.models[0]?.thinkingBudgets);
    override.models[0].thinkingBudgets.low = 4096;
    expect(mapped?.thinkingBudgets).toEqual({ low: 2048 });
  });

  test("AC-3 omits both undeclared properties", () => {
    const { thinkingBudgetField: _field, thinkingBudgets: _budgets, ...model } = strata().models[0];
    const mapped = toProviderOverrides([{ ...strata(), models: [model] }])[0]?.models?.[0];
    expect(mapped).toBeDefined();
    expect(Object.hasOwn(mapped ?? {}, "thinkingBudgetField")).toBe(false);
    expect(Object.hasOwn(mapped ?? {}, "thinkingBudgets")).toBe(false);
  });
});

describe("buildNativeClient thinking budgets", () => {
  test("AC-4 sends the model-owned low budget on the actual wire", async () => {
    process.env.STRATA_KEY = "k-wire";
    const dependency = await dependencyBuildState();
    const bodies: unknown[] = [];
    const requests: { url: string; authorization: string | null }[] = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      requests.push({ url, authorization: headers.get("Authorization") });
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: "stop" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const client = await buildNativeClient([strata()], { transportRetries: 0 });
    const model = await client.model("strata", "qwen3.8-flash");
    // Preserve build fingerprints in assertion output before anyone rebuilds
    // the dependency and destroys evidence of a stale artifact.
    const declaration = { thinkingBudgetField: model.thinkingBudgetField, thinkingBudgets: model.thinkingBudgets };
    const buildContext = JSON.stringify({ dependency, declaration });
    expect(model.thinkingBudgetField, buildContext).toBe("reasoning_budget_tokens");
    expect(model.thinkingBudgets, buildContext).toEqual({ low: 2048 });
    for await (const _event of client.stream(model, {
      messages: [{ role: "user", content: "hi" }],
      thinking: "low",
    })) {
      // The intercepted 401 terminates the stream; the request is the contract.
    }
    expect(requests).toEqual([{ url: "http://127.0.0.1:18080/v1/chat/completions", authorization: "Bearer k-wire" }]);
    // Only synthetic request JSON and URLs are captured, never auth headers.
    const wireContext = JSON.stringify({ dependency, declaration, bodies, urls: requests.map(({ url }) => url) });
    expect(bodies, wireContext).toHaveLength(1);
    expect(bodies[0], wireContext).toHaveProperty("reasoning_budget_tokens", 2048);
  });

  test("AC-5 preserves invalid declarations for upstream validation", async () => {
    await expect(buildNativeClient([strata("max_tokens")], { transportRetries: 0 })).rejects.toThrow("max_tokens");
  });
});
