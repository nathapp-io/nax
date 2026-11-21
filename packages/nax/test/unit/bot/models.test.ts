import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { botModel, checkBotModelOverride, parseModelOption } from "@/bot";
import { type NaxConfig, NaxConfigSchema } from "@/config";
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

describe("checkBotModelOverride", () => {
  /** Default agent `native`, and its tier map holds exactly `tiers` (insertion order preserved). */
  function nativeTiers(tiers: Record<string, string>): NaxConfig {
    return { ...makeNaxConfig(), models: { native: tiers } };
  }
  const tiers = { fast: "anthropic/claude-haiku-4-5", balanced: "anthropic/claude-sonnet-5" };

  test("US-003 AC-1: an absent override is never checked", () => {
    expect(checkBotModelOverride(makeNaxConfig(), undefined)).toBeUndefined();
  });

  test("US-003 AC-2: a tier the default agent configures resolves", () => {
    expect(checkBotModelOverride(nativeTiers(tiers), "balanced")).toBeUndefined();
  });

  test("US-003 AC-3: an explicit agent:model selection still dispatches as a literal", () => {
    expect(
      checkBotModelOverride(nativeTiers(tiers), { agent: "native", model: "openai-codex/gpt-6.1-sol[high]" }),
    ).toBeUndefined();
  });

  test("US-003 AC-4: an unrecognized explicit literal keeps its warn-only treatment", () => {
    expect(
      checkBotModelOverride(nativeTiers(tiers), { agent: "native", model: "nax-unknown-model-id" }),
    ).toBeUndefined();
  });

  test("US-003 AC-5: an unresolvable tier is refused with the resolver's own reason", () => {
    expect(checkBotModelOverride(nativeTiers(tiers), "nope")).toStartWith(
      'invalid --model "nope": No model entry found',
    );
  });

  test("US-003 AC-6: the refusal names the accepted forms", () => {
    expect(checkBotModelOverride(nativeTiers(tiers), "nope")).toContain("accepted forms: <tier> or <agent>:<model>");
  });

  test("US-003 AC-7: the refusal lists the default agent's configured tiers", () => {
    expect(checkBotModelOverride(nativeTiers(tiers), "nope")).toContain("configured tiers: fast, balanced");
  });

  test("US-003 AC-8: the tier list ends the refusal, with no agent-prefix hint after it", () => {
    expect(checkBotModelOverride(nativeTiers(tiers), "nope")?.endsWith("configured tiers: fast, balanced")).toBe(true);
  });

  test("US-003 AC-9: a provider/model id is told to name its agent", () => {
    expect(checkBotModelOverride(nativeTiers(tiers), "openai-codex/gpt-6.1-sol[high]")).toContain(
      "a provider/model id needs its agent prefix, for example native:openai-codex/gpt-6.1-sol[high]",
    );
  });

  test("US-003 AC-15: no entry for the default agent reports no tiers", () => {
    expect(checkBotModelOverride({ ...makeNaxConfig(), models: { claude: tiers } }, "nope")).toContain(
      "configured tiers: none",
    );
  });

  // Branch fix B3: `models[agent]?.[tier]` reads through Object.prototype, so a name such as
  // `constructor` answered with an inherited function and passed this preflight — the fix session
  // then started runtime setup and failed somewhere no reason reached the user.
  test.each(["constructor", "toString", "valueOf", "__proto__"])("B3: an inherited name is refused: %s", (name) => {
    expect(checkBotModelOverride(nativeTiers(tiers), name)).toStartWith(`invalid --model "${name}": No model entry`);
  });
});

describe("agent:@alias overrides", () => {
  const SOL = "openai-codex/gpt-6.1-sol";
  const aliased = (aliases: Record<string, string>): NaxConfig => ({
    ...makeNaxConfig(),
    agent: { ...makeNaxConfig().agent, modelAliases: aliases },
  });

  test("AC-1: a bare @name is refused naming <agent>:@sol", () => {
    const err = (() => {
      try {
        parseModelOption("@sol");
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(NaxError);
    expect((err as NaxError).code).toBe("BOT_MODEL_INVALID");
    expect((err as NaxError).message).toContain("<agent>:@sol");
  });
  test("AC-2: native:@sol[high] parses unexpanded", () => {
    expect(parseModelOption("native:@sol[high]")).toEqual({ agent: "native", model: "@sol[high]" });
  });
  test("AC-17: a tier with no colon and no @ is unchanged", () => {
    expect(parseModelOption("balanced")).toBe("balanced");
  });
  test("AC-3: a known alias passes the check", () => {
    expect(checkBotModelOverride(aliased({ sol: SOL }), { agent: "native", model: "@sol" })).toBeUndefined();
  });
  test("AC-6: an acp: alias is refused", () => {
    expect(
      checkBotModelOverride(aliased({ r: "acp:codex/gpt-6.1-terra" }), { agent: "native", model: "@r" }),
    ).toContain("usable only from agent files");
  });
  test("an unknown alias is refused", () => {
    expect(checkBotModelOverride(aliased({}), { agent: "native", model: "@nope" })).toContain(
      'unknown model alias "nope"',
    );
  });
  test("AC-7: botModel expands the override with its effort suffix", () => {
    expect(botModel(aliased({ sol: SOL }), "review", { agent: "native", model: "@sol[high]" })).toEqual({
      agent: "native",
      model: `${SOL}[high]`,
    });
  });
  test("AC-8: botModel expands for rulings", () => {
    expect(botModel(aliased({ sol: SOL }), "rulings", { agent: "native", model: "@sol" })).toEqual({
      agent: "native",
      model: SOL,
    });
  });
  test("AC-18: a literal override is returned deep-equal", () => {
    const o = { agent: "native", model: SOL };
    expect(botModel(aliased({ sol: SOL }), "review", o)).toEqual(o);
  });
});
