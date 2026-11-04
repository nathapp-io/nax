import { describe, expect, it } from "vitest";
import { createClient } from "../../src/client.ts";
import { createPiDeps } from "../../src/protocols/pi-client.ts";
import * as validators from "../../src/providers/override-model.ts";
import type { ProviderOverride, ResolvedModel } from "../../src/providers/types.ts";

const LOCAL: ResolvedModel = {
  id: "local-qwen",
  provider: "together",
  protocol: "openai-completions",
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 131072,
  maxTokens: 32768,
  supportsTools: true,
  thinkingLevels: ["off", "low", "high"],
};
const FIELD = "reasoning_budget_tokens";
function overrides(model: ResolvedModel): ProviderOverride[] {
  return [{ provider: model.provider, baseUrl: "http://127.0.0.1:18080/v1", models: [model] }];
}
function validate(model: ResolvedModel): void {
  // Ensure missing exports cannot make a rejection test pass by accident.
  expect(typeof validators.assertOverrideModelThinkingBudget).toBe("function");
  validators.assertOverrideModelThinkingBudget(model);
}

describe("assertOverrideModelThinkingBudget", () => {
  it.each([
    ["AC-3", { protocol: "anthropic-messages", thinkingBudgetField: "thinking_budget" }, "openai-completions"],
    ["AC-4", { thinkingBudgets: { low: 2048 } }, "thinkingBudgetField"],
    ["AC-5", { thinkingBudgetField: "max_tokens" }, "max_tokens"],
    ["AC-6", { thinkingBudgetField: "priority" }, "priority"],
    ["AC-7", { thinkingBudgetField: "Reasoning-Budget" }, "Reasoning-Budget"],
    [
      "AC-8",
      { thinkingLevels: ["off", "low"], thinkingBudgetField: FIELD, thinkingBudgets: { medium: 6144 } },
      "medium",
    ],
    ["AC-10", { thinkingBudgetField: FIELD, thinkingBudgets: { low: 0 } }, "low"],
    ["AC-11", { thinkingBudgetField: FIELD, thinkingBudgets: { low: 1.5 } }, "low"],
    ["AC-12", { thinkingBudgetField: FIELD, thinkingBudgets: {} }, "empty"],
  ] as const)("%s rejects invalid metadata", (_ac, patch, message) => {
    expect(() => validate({ ...LOCAL, ...patch })).toThrow(message);
  });

  it.each([
    ["AC-9", { thinkingLevels: ["off", "xhigh"], thinkingBudgets: { high: 12000 } }],
    ["AC-13", { thinkingBudgets: { low: 2048 } }],
    ["max uses high", { thinkingLevels: ["off", "max"], thinkingBudgets: { high: 12000 } }],
    ["field only", {}],
  ] as const)("%s accepts valid metadata", (_ac, patch) => {
    expect(() => validate({ ...LOCAL, thinkingBudgetField: FIELD, ...patch })).not.toThrow();
  });

  it.each([
    "model",
    "messages",
    "stream",
    "stream_options",
    "tools",
    "tool_choice",
    "max_tokens",
    "max_completion_tokens",
    "temperature",
    "top_p",
    "reasoning",
    "reasoning_effort",
    "provider",
    "priority",
    "store",
    "prompt_cache_key",
    "prompt_cache_retention",
    "chat_template_kwargs",
    "chat_template_args",
    "enable_thinking",
    "thinking",
    "tool_stream",
    "providerOptions",
    "",
    "a".repeat(65),
  ])("rejects colliding or malformed field %s and names the model", (thinkingBudgetField) => {
    expect(() => validate({ ...LOCAL, thinkingBudgetField })).toThrow(/local-qwen/);
  });

  it.each([{ xhigh: 4096 }, { low: -1 }, { low: Number.NaN }, { low: Number.POSITIVE_INFINITY }])(
    "rejects invalid budgets %j",
    (thinkingBudgets) => {
      expect(() => validate({ ...LOCAL, thinkingBudgetField: FIELD, thinkingBudgets })).toThrow(/local-qwen/);
    },
  );

  it("checks protocol before missing field, then field before budget contents", () => {
    expect(() => validate({ ...LOCAL, protocol: "openai-responses", thinkingBudgets: {} })).toThrow(
      /openai-completions/,
    );
    expect(() => validate({ ...LOCAL, thinkingBudgets: {} })).toThrow(/thinkingBudgetField/);
    expect(() => validate({ ...LOCAL, thinkingBudgetField: "max_tokens", thinkingBudgets: {} })).toThrow(/max_tokens/);
  });

  it("allows absent declarations on other protocols", () => {
    expect(() => validate({ ...LOCAL, protocol: "anthropic-messages" })).not.toThrow();
  });
});

describe("thinking-budget catalog synthesis", () => {
  it("AC-1 retains a budget-only bundled-provider override and inherited compat", async () => {
    const control = await createPiDeps({ providerOverrides: overrides(LOCAL) }).resolveModel(LOCAL.id, LOCAL.provider);
    const model = { ...LOCAL, thinkingBudgetField: FIELD, thinkingBudgets: { low: 2048 } };
    const resolved = await createPiDeps({ providerOverrides: overrides(model) }).resolveModel(model.id, model.provider);
    expect(resolved.compat).toEqual({ ...control.compat, thinkingTokenBudgetField: FIELD });
  });

  it("AC-2 synthesises an introduced provider's budget field without budgets", async () => {
    const model = { ...LOCAL, provider: "strata", id: "qwen3.8-flash", thinkingBudgetField: FIELD };
    const resolved = await createPiDeps({ providerOverrides: overrides(model) }).resolveModel(model.id, model.provider);
    expect(resolved.compat).toMatchObject({ thinkingTokenBudgetField: FIELD });
  });

  it("AC-14 rejects a reserved field through createClient", () => {
    expect(() =>
      createClient({
        providers: [],
        protocols: {},
        providerOverrides: overrides({ ...LOCAL, thinkingBudgetField: "max_tokens" }),
      }),
    ).toThrow(/max_tokens/);
  });

  it.each([
    ["AC-15", "together"],
    ["AC-16", "strata"],
  ])("%s rejects reserved fields through createPiDeps (%s)", (_ac, provider) => {
    expect(() =>
      createPiDeps({ providerOverrides: overrides({ ...LOCAL, provider, thinkingBudgetField: "max_tokens" }) }),
    ).toThrow(/max_tokens/);
  });

  it("AC-17 preserves introduced format and routing without either budget property", async () => {
    const model = {
      ...LOCAL,
      provider: "strata",
      thinkingFormat: "openrouter",
      openRouterRouting: { only: ["host"] },
    } as const;
    const resolved = await createPiDeps({ providerOverrides: overrides(model) }).resolveModel(model.id, model.provider);
    expect(resolved.compat).toEqual({ thinkingFormat: "openrouter", openRouterRouting: { only: ["host"] } });
  });
});
