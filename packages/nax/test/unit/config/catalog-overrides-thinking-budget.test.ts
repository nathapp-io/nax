import { describe, expect, test } from "bun:test";
import { toProviderOverrides } from "@nathapp/nax-agent/internal";
import { FIELD_DESCRIPTIONS } from "@/cli/config-descriptions";
import { NaxConfigSchema } from "@/config";
import type { CatalogModelOverride } from "@/config/schema-types";

const MODEL = {
  id: "qwen3.8-flash",
  protocol: "openai-completions",
  contextWindow: 131_072,
  maxTokens: 32_768,
  supportsTools: true,
  thinkingLevels: ["off", "low", "high"],
  pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies CatalogModelOverride;
const BUDGET = {
  thinkingBudgetField: "reasoning_budget_tokens",
  thinkingBudgets: { low: 2048, high: 16_384 },
};

function rootConfig(fields: Record<string, unknown> = {}) {
  return {
    agent: { native: { catalogOverrides: [{ provider: "strata", models: [{ ...MODEL, ...fields }] }] } },
  };
}

function parseOverrides(fields: Record<string, unknown> = {}) {
  const config = NaxConfigSchema.parse(rootConfig(fields));
  const overrides = config.agent?.native?.catalogOverrides;
  expect(overrides).toBeDefined();
  return overrides ?? [];
}

describe("catalog override thinking budgets", () => {
  test("AC-1 keeps both budget declarations in typed root config output", () => {
    expect(parseOverrides(BUDGET)[0]?.models[0]).toMatchObject(BUDGET);
  });

  test("AC-2 requires thinkingBudgetField when budgets are declared", () => {
    const result = NaxConfigSchema.safeParse(rootConfig({ thinkingBudgets: { low: 2048 } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("thinkingBudgetField");
  });

  test.each(["Reasoning-Budget", "", "1budget", "a".repeat(65), "budget.tokens"])(
    "AC-3 rejects malformed field %j at the field path",
    (thinkingBudgetField) => {
      const result = NaxConfigSchema.safeParse(rootConfig({ thinkingBudgetField }));
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["agent", "native", "catalogOverrides", 0, "models", 0, "thinkingBudgetField"],
          }),
        );
      }
    },
  );

  test("AC-4 names an undeclared budget level", () => {
    const result = NaxConfigSchema.safeParse(
      rootConfig({
        thinkingLevels: ["off", "low"],
        thinkingBudgetField: "thinking_budget",
        thinkingBudgets: { medium: 6144 },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain("medium");
  });

  test.each(["max", "xhigh"])("AC-5 accepts a high budget for %s", (level) => {
    expect(
      parseOverrides({
        thinkingLevels: ["off", level],
        thinkingBudgetField: "thinking_budget",
        thinkingBudgets: { high: 12_000 },
      })[0]?.models[0],
    ).toHaveProperty("thinkingBudgets", { high: 12_000 });
  });

  test.each([
    ["AC-6", { low: 0 }],
    ["AC-6 negative", { low: -1 }],
    ["AC-7", { low: 1.5 }],
    ["AC-8", { xhigh: 4096 }],
    ["AC-9", {}],
  ])("%s rejects invalid budgets at the budget path", (_ac, thinkingBudgets) => {
    const result = NaxConfigSchema.safeParse(rootConfig({ thinkingBudgetField: "thinking_budget", thinkingBudgets }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("thinkingBudgets"))).toBe(true);
    }
  });

  test("AC-10 keeps a field-only declaration", () => {
    const model = parseOverrides({ thinkingBudgetField: "thinking_budget" })[0]?.models[0];
    expect(model).toHaveProperty("thinkingBudgetField", "thinking_budget");
    expect(model).not.toHaveProperty("thinkingBudgets");
  });

  test("AC-11 forwards parsed override arrays through the real nax-agent mapper", () => {
    const mapped = toProviderOverrides(parseOverrides(BUDGET));
    expect(mapped?.[0]?.models?.[0]).toMatchObject(BUDGET);
  });

  test("AC-12 describes the budget field in CLI help", () => {
    expect(FIELD_DESCRIPTIONS["agent.native.catalogOverrides.thinkingBudgetField"]?.trim().length).toBeGreaterThan(0);
  });

  test("AC-13 describes budgets and the xhigh mapping in CLI help", () => {
    const description = FIELD_DESCRIPTIONS["agent.native.catalogOverrides.thinkingBudgets"];
    expect(description?.trim().length).toBeGreaterThan(0);
    expect(description).toContain("xhigh");
  });

  test("AC-14 preserves legacy omission of both settings", () => {
    const model = parseOverrides()[0]?.models[0];
    expect(model).toEqual(MODEL);
    expect(model).not.toHaveProperty("thinkingBudgetField");
    expect(model).not.toHaveProperty("thinkingBudgets");
  });
});
