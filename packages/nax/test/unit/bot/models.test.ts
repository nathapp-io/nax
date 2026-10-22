import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { botModel, parseModelOption } from "@/bot";
import { NaxConfigSchema } from "@/config";
import { NaxError } from "@/errors";

describe("botModel", () => {
  test("US-008 AC-1: rulings defaults to fast without workflow fallback", () => {
    expect(botModel(makeNaxConfig({ workflow: { models: { branchFix: "powerful" } } }), "rulings")).toBe("fast");
  });
  test("US-008 AC-2: schema preserves the rulings model", () => {
    const config = NaxConfigSchema.parse({ bot: { models: { rulings: "balanced" } } });
    expect(botModel(makeNaxConfig({ bot: config.bot }), "rulings")).toBe("balanced");
  });
  test("US-008 AC-3: explicit rulings override wins", () => {
    const model = { agent: "native", model: "custom" };
    expect(botModel(makeNaxConfig({ bot: { models: { rulings: "balanced" } } }), "rulings", model)).toBe(model);
  });
  test("AC-6: review override wins over bot config", () => {
    const config = makeNaxConfig({ bot: { models: { review: "powerful" } } });
    expect(botModel(config, "review", "fast")).toBe("fast");
  });

  test.each([
    ["AC-7", "review", "branchReview", "quality"],
    ["AC-11", "fix", "branchFix", "fix"],
  ] as const)("%s: %s bot model wins over workflow and finish", (_ac, role, workflowRole, finishRole) => {
    const config = makeNaxConfig({
      bot: { models: { [role]: "powerful" } },
      workflow: { models: { [workflowRole]: "balanced" } },
      finish: { reviewers: { [finishRole]: "fast" } },
    });
    expect(botModel(config, role)).toBe("powerful");
  });

  test.each([
    ["AC-8", "review", "branchReview", "quality"],
    ["AC-12", "fix", "branchFix", "fix"],
  ] as const)("%s: %s falls back to workflow before finish", (_ac, role, workflowRole, finishRole) => {
    const config = makeNaxConfig({
      workflow: { models: { [workflowRole]: "balanced" } },
      finish: { reviewers: { [finishRole]: "fast" } },
    });
    expect(botModel(config, role)).toBe("balanced");
  });

  test.each([
    ["AC-9", "review", "quality"],
    ["AC-13", "fix", "fix"],
  ] as const)("%s: %s falls back to finish", (_ac, role, finishRole) => {
    const config = makeNaxConfig({ finish: { reviewers: { [finishRole]: "fast" } } });
    expect(botModel(config, role)).toBe("fast");
  });

  test.each(["review", "fix"] as const)("AC-10: %s leaves the tier unset when no models are configured", (role) => {
    expect(botModel(makeNaxConfig(), role)).toBeUndefined();
    expect(botModel(makeNaxConfig({ bot: undefined, workflow: undefined, finish: undefined }), role)).toBeUndefined();
  });

  test("preserves an explicit model object and supports a fix override", () => {
    const model = { agent: "native", model: "m" };
    const config = makeNaxConfig({ bot: { models: { fix: model } } });
    expect(botModel(config, "fix")).toEqual(model);
    expect(botModel(config, "fix", model)).toBe(model);
  });
});

describe("parseModelOption", () => {
  test("AC-14: parses a provider-qualified model with thinking suffix", () => {
    expect(parseModelOption("native:openai-codex/gpt-6.1-sol[high]")).toEqual({
      agent: "native",
      model: "openai-codex/gpt-6.1-sol[high]",
    });
  });

  test("AC-15: returns a bare tier string", () => {
    expect(parseModelOption("powerful")).toBe("powerful");
  });

  test("splits only the first colon", () => {
    expect(parseModelOption("native:provider:model")).toEqual({ agent: "native", model: "provider:model" });
  });

  test.each([
    ["AC-16", ""],
    ["AC-17", "native:"],
    ["empty agent", ":model"],
    ["both empty", ":"],
  ])("%s: rejects invalid model option %j with BOT_MODEL_INVALID", (_ac, value) => {
    expect(() => parseModelOption(value)).toThrow(NaxError);
    expect(() => parseModelOption(value)).toThrow(expect.objectContaining({ code: "BOT_MODEL_INVALID" }));
  });
});
