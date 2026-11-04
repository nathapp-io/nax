import { afterEach, describe, expect, test } from "bun:test";
import type { CatalogModelOverride, ProviderCatalogOverride } from "#src/config/catalog-overrides";
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
    const bodies: unknown[] = [];
    globalThis.fetch = mockFetch(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ error: { message: "stop" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    });
    const client = await buildNativeClient([strata()], { transportRetries: 0 });
    const model = await client.model("strata", "qwen3.8-flash");
    for await (const _event of client.stream(model, {
      messages: [{ role: "user", content: "hi" }],
      thinking: "low",
    })) {
      // The intercepted 401 terminates the stream; the request is the contract.
    }
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveProperty("reasoning_budget_tokens", 2048);
  });

  test("AC-5 preserves invalid declarations for upstream validation", async () => {
    await expect(buildNativeClient([strata("max_tokens")], { transportRetries: 0 })).rejects.toThrow("max_tokens");
  });
});
