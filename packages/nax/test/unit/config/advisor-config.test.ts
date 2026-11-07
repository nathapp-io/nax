import { describe, expect, test } from "bun:test";
import {
  ADVISOR_DEFAULTS,
  advisorConfigSelector,
  DEFAULT_CONFIG,
  NaxConfigSchema,
  resolveAdvisorConfig,
} from "@/config";

describe("advisor config", () => {
  test("schema fills every nested default (Zod 4 prefault)", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.advisor).toEqual({
      enabled: false,
      model: "powerful",
      fallbackModels: [],
      memory: "stateless",
      callers: { finishJudgment: false, fixCycleGiveUp: false, uncategorisedFailure: false, finishApproval: false },
      maxRulingsPerStory: 2,
      notify: { headsUp: true },
    });
  });

  test("fallbackModels defaults to [] and accepts tiers and literal pins", () => {
    expect(NaxConfigSchema.parse({}).advisor?.fallbackModels).toEqual([]);
    const parsed = NaxConfigSchema.parse({
      advisor: { fallbackModels: ["powerful", { agent: "claude", model: "sonnet[medium]" }] },
    });
    expect(parsed.advisor?.fallbackModels).toEqual(["powerful", { agent: "claude", model: "sonnet[medium]" }]);
  });

  test("a partial block keeps the other defaults", () => {
    const parsed = NaxConfigSchema.parse({ advisor: { enabled: true, callers: { finishJudgment: true } } });
    expect(parsed.advisor?.callers).toEqual({
      finishJudgment: true,
      fixCycleGiveUp: false,
      uncategorisedFailure: false,
      finishApproval: false,
    });
    expect(parsed.advisor?.model).toBe("powerful");
  });

  test("resolveAdvisorConfig falls back to defaults when the block is absent", () => {
    expect(resolveAdvisorConfig(undefined)).toEqual(ADVISOR_DEFAULTS);
    expect(resolveAdvisorConfig({})).toEqual(ADVISOR_DEFAULTS);
  });

  test("rejects an unknown memory mode", () => {
    expect(() => NaxConfigSchema.parse({ advisor: { memory: "forever" } })).toThrow();
  });

  test("selector exposes the advisor and execution slices", () => {
    const sliced = advisorConfigSelector.select(DEFAULT_CONFIG);
    expect(Object.keys(sliced).sort()).toEqual(["advisor", "execution"]);
  });
});
