import { describe, expect, test } from "bun:test";
import {
  ADVISOR_DEFAULTS,
  advisorConfigSelector,
  DEFAULT_CONFIG,
  isAdvisorCallerEnabled,
  NaxConfigSchema,
  resolveAdvisorConfig,
} from "@/config";

describe("advisor config", () => {
  test("schema fills every nested default (Zod 4 prefault)", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.advisor).toEqual({
      enabled: false,
      model: "powerful",
      memory: "stateless",
      callers: { finishJudgment: false, fixCycleGiveUp: false, uncategorisedFailure: false, finishApproval: false },
      maxRulingsPerStory: 2,
      notify: { headsUp: true },
    });
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

  test("a caller runs only when the master switch AND its own flag are on", () => {
    const on = { ...ADVISOR_DEFAULTS, enabled: true, callers: { ...ADVISOR_DEFAULTS.callers, finishApproval: true } };
    expect(isAdvisorCallerEnabled({ advisor: on }, "finishApproval")).toBe(true);
    expect(isAdvisorCallerEnabled({ advisor: on }, "finishJudgment")).toBe(false);
    expect(isAdvisorCallerEnabled({ advisor: { ...on, enabled: false } }, "finishApproval")).toBe(false);
    expect(isAdvisorCallerEnabled(undefined, "finishApproval")).toBe(false);
  });

  test("rejects an unknown memory mode", () => {
    expect(() => NaxConfigSchema.parse({ advisor: { memory: "forever" } })).toThrow();
  });

  test("selector exposes the advisor and execution slices", () => {
    const sliced = advisorConfigSelector.select(DEFAULT_CONFIG);
    expect(Object.keys(sliced).sort()).toEqual(["advisor", "execution"]);
  });
});
