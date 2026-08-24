/**
 * NaxConfigSchema — ModelsSchema per-agent shape and legacy migration tests
 *
 * Story US-001-3: Update ModelsSchema in schemas.ts with per-agent shape and
 * legacy migration transform.
 *
 * These tests cover:
 * - Legacy flat model config auto-migration to per-agent shape using defaultAgent
 * - New per-agent config is preserved unchanged
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { NaxConfigSchema } from "@/config/schemas";

/** Minimal valid config base — everything except models */
function baseConfig(models: unknown) {
  return { ...DEFAULT_CONFIG, models };
}

describe("ModelsSchema — legacy flat config migration", () => {
  test("auto-migrates legacy flat ModelDef object: tier keys move under defaultAgent, original values preserved", () => {
    const legacy = {
      fast: { provider: "anthropic", model: "haiku" },
      balanced: { provider: "anthropic", model: "sonnet" },
      powerful: { provider: "anthropic", model: "opus" },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(legacy));

    expect(result.success).toBe(true);
    if (!result.success) return;

    const defaultAgent = DEFAULT_CONFIG.agent?.default ?? "claude";
    const models = result.data.models as Record<string, Record<string, unknown>>;

    expect(models[defaultAgent]).toBeDefined();
    expect(models.fast).toBeUndefined();
    expect(models.balanced).toBeUndefined();
    expect(models.powerful).toBeUndefined();
    expect(models[defaultAgent].fast).toEqual({ provider: "anthropic", model: "haiku" });
    expect(models[defaultAgent].balanced).toEqual({ provider: "anthropic", model: "sonnet" });
    expect(models[defaultAgent].powerful).toEqual({ provider: "anthropic", model: "opus" });
  });

  test("auto-migrates legacy flat string entries: tier keys move under defaultAgent, string values preserved", () => {
    const legacy = {
      fast: "claude-haiku-4-5",
      balanced: "claude-sonnet-4-5",
      powerful: "claude-opus-4-5",
    };

    const result = NaxConfigSchema.safeParse(baseConfig(legacy));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const defaultAgent = DEFAULT_CONFIG.agent?.default ?? "claude";
    const models = result.data.models as Record<string, Record<string, unknown>>;

    expect(models[defaultAgent]).toBeDefined();
    expect(models.fast).toBeUndefined();
    expect(models[defaultAgent].fast).toBe("claude-haiku-4-5");
    expect(models[defaultAgent].balanced).toBe("claude-sonnet-4-5");
  });

  test.each([
    ["value with 'provider' key", { fast: { provider: "anthropic", model: "haiku" } }],
    ["string value at top level", { fast: "claude-haiku" }],
  ])("detection: %s triggers legacy migration (tier keys move under agent)", (_label, legacy) => {
    const result = NaxConfigSchema.safeParse(baseConfig(legacy));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const models = result.data.models as Record<string, unknown>;
    expect(models.fast).toBeUndefined();
  });
});

describe("ModelsSchema — new per-agent config (no migration)", () => {
  test("preserves new per-agent config unchanged when format is correct", () => {
    const perAgent = {
      claude: {
        fast: "haiku",
        balanced: "sonnet",
        powerful: "opus",
      },
      codex: {
        fast: "gpt-5",
      },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(perAgent));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, Record<string, unknown>>;
    expect(models.claude).toBeDefined();
    expect(models.codex).toBeDefined();
  });

  test("per-agent config: claude agent entries are preserved intact", () => {
    const perAgent = {
      claude: {
        fast: "haiku",
        balanced: "sonnet",
        powerful: "opus",
      },
      codex: {
        fast: "gpt-5",
      },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(perAgent));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, Record<string, unknown>>;
    expect(models.claude.fast).toBe("haiku");
    expect(models.claude.balanced).toBe("sonnet");
    expect(models.claude.powerful).toBe("opus");
  });

  test("per-agent config: codex agent entries are preserved intact", () => {
    const perAgent = {
      claude: { fast: "haiku" },
      codex: { fast: "gpt-5" },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(perAgent));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, Record<string, unknown>>;
    expect(models.codex.fast).toBe("gpt-5");
  });

  test("per-agent config: ModelDef objects at tier level are preserved", () => {
    const perAgent = {
      claude: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5" },
        balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
      },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(perAgent));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, Record<string, unknown>>;
    expect(models.claude.fast).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  test("per-agent config: no legacy tier names appear at top level", () => {
    const perAgent = {
      claude: { fast: "haiku" },
      codex: { fast: "gpt-5" },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(perAgent));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, unknown>;
    // Tier names should NOT be top-level keys
    expect(models.fast).toBeUndefined();
    expect(models.balanced).toBeUndefined();
    expect(models.powerful).toBeUndefined();
  });

  test("per-agent config: mixed string and object tier entries are preserved", () => {
    const perAgent = {
      claude: {
        fast: "haiku",
        balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
      },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(perAgent));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, Record<string, unknown>>;
    expect(models.claude.fast).toBe("haiku");
    expect(models.claude.balanced).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });
});

describe("StorySizeGateConfigSchema — action and maxReplanAttempts (US-001)", () => {
  function basePrecheckConfig(storySizeGate: Record<string, unknown>) {
    return { ...DEFAULT_CONFIG, precheck: { storySizeGate } };
  }

  test("action defaults to 'block' and maxReplanAttempts defaults to 3 when omitted", () => {
    const withoutAction = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      maxReplanAttempts: 3,
    });
    const r1 = NaxConfigSchema.safeParse(withoutAction);
    expect(r1.success).toBe(true);
    if (!r1.success) return;
    const ssg1 = ((r1.data as Record<string, unknown>).precheck as Record<string, unknown>).storySizeGate as Record<
      string,
      unknown
    >;
    expect(ssg1.action).toBe("block");

    const withoutMax = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      action: "block",
    });
    const r2 = NaxConfigSchema.safeParse(withoutMax);
    expect(r2.success).toBe(true);
    if (!r2.success) return;
    const ssg2 = ((r2.data as Record<string, unknown>).precheck as Record<string, unknown>).storySizeGate as Record<
      string,
      unknown
    >;
    expect(ssg2.maxReplanAttempts).toBe(3);
  });

  test.each(["warn", "skip"])("action accepts '%s'", (action) => {
    const config = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      maxReplanAttempts: 3,
      action,
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("action rejects invalid values; maxReplanAttempts rejects 0 (must be >= 1)", () => {
    const badAction = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      maxReplanAttempts: 3,
      action: "invalid",
    });
    expect(NaxConfigSchema.safeParse(badAction).success).toBe(false);

    const badMax = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      action: "block",
      maxReplanAttempts: 0,
    });
    expect(NaxConfigSchema.safeParse(badMax).success).toBe(false);
  });
});

describe("configured model selector schema", () => {
  test("accepts object form for plan.model", () => {
    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      plan: {
        ...DEFAULT_CONFIG.plan,
        model: { agent: "codex", model: "gpt-5.4" },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.plan.model).toEqual({ agent: "codex", model: "gpt-5.4" });
  });

  test("accepts object form for acceptance.model", () => {
    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        model: { agent: "codex", model: "fast" },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.acceptance.model).toEqual({ agent: "codex", model: "fast" });
  });

  test("accepts object form for routing.llm.model", () => {
    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      routing: {
        ...DEFAULT_CONFIG.routing,
        llm: {
          ...DEFAULT_CONFIG.routing?.llm,
          model: { agent: "claude", model: "sonnet" },
        },
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.routing.llm?.model).toEqual({ agent: "claude", model: "sonnet" });
  });
});

describe("ModelsSchema — DEFAULT_CONFIG compatibility", () => {
  test("DEFAULT_CONFIG (legacy flat format) parses successfully after migration", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  test("DEFAULT_CONFIG after migration has per-agent structure", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, unknown>;
    // Should contain agent key (defaultAgent = "claude"), not tier keys
    expect(models.claude).toBeDefined();
  });
});

describe("profile field — US-001-A", () => {
  test.each([
    ["default", DEFAULT_CONFIG],
    ["fast", { ...DEFAULT_CONFIG, profile: "fast" }],
  ])("profile equals '%s' when parsed with that value", (profile, input) => {
    const result = NaxConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.profile).toBe(profile);
  });
});

describe("DebateStageConfigSchema — mode field (US-001-B)", () => {
  type DebateStages = {
    plan: { mode: string };
    review: { mode: string };
    acceptance: { mode: string };
    rectification: { mode: string };
    escalation: { mode: string };
  };

  function getStages(): DebateStages {
    const parsed = NaxConfigSchema.parse({});
    return (parsed as unknown as { debate: { stages: DebateStages } }).debate.stages;
  }

  test.each(["plan", "review", "acceptance", "rectification", "escalation"] as const)(
    "stages.%s.mode defaults to 'panel'",
    (stage) => {
      expect(getStages()[stage].mode).toBe("panel");
    },
  );

  test("stages.plan.mode accepts 'hybrid'", () => {
    const result = NaxConfigSchema.safeParse({
      debate: { stages: { plan: { mode: "hybrid" } } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const stages = (result.data as unknown as { debate: { stages: DebateStages } }).debate.stages;
    expect(stages.plan.mode).toBe("hybrid");
  });

  test("stages.plan.mode rejects invalid value 'sequential'", () => {
    const result = NaxConfigSchema.safeParse({
      debate: { stages: { plan: { mode: "sequential" } } },
    });
    expect(result.success).toBe(false);
  });
});

describe("QualityConfigSchema — scopeTestThreshold (US-001)", () => {
  test.each([
    [{}, 10],
    [{ quality: { scopeTestThreshold: 5 } }, 5],
  ])("scopeTestThreshold: input %j → %d", (input, expected) => {
    expect(NaxConfigSchema.parse(input).quality.scopeTestThreshold).toBe(expected);
  });

  test("scopeTestThreshold rejects negative values", () => {
    const result = NaxConfigSchema.safeParse({ quality: { scopeTestThreshold: -1 } });
    expect(result.success).toBe(false);
  });

  test.each([0, 1000])("scopeTestThreshold accepts %d", (value) => {
    const result = NaxConfigSchema.parse({ quality: { scopeTestThreshold: value } });
    expect(result.quality.scopeTestThreshold).toBe(value);
  });
});

describe("NaxConfigSchema — superRefine: tierOrder agent cross-section validation", () => {
  const MODELS = {
    opencode: { balanced: "oc-model", fast: "oc-fast" },
    claude: { balanced: "sonnet", powerful: "opus" },
  };

  function withTierOrder(tierOrder: Array<{ tier: string; agent?: string; attempts: number }>, models?: unknown) {
    return NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      ...(models !== undefined ? { models } : {}),
      autoMode: {
        ...DEFAULT_CONFIG.autoMode,
        escalation: {
          ...DEFAULT_CONFIG.autoMode?.escalation,
          tierOrder,
        },
      },
    });
  }

  test("valid cross-agent ladder passes", () => {
    const result = withTierOrder(
      [
        { tier: "balanced", agent: "opencode", attempts: 3 },
        { tier: "balanced", agent: "claude", attempts: 2 },
        { tier: "powerful", agent: "claude", attempts: 2 },
      ],
      MODELS,
    );
    expect(result.success).toBe(true);
  });

  test("unknown agent in tierOrder produces exactly one issue (not two)", () => {
    const result = withTierOrder([{ tier: "balanced", agent: "nonexistent", attempts: 3 }], MODELS);
    expect(result.success).toBe(false);
    if (result.success) return;
    const agentIssues = result.error.issues.filter((e) => e.message.includes("nonexistent"));
    expect(agentIssues).toHaveLength(1);
    expect(agentIssues[0].message).toMatch(/not defined in config\.models/);
  });

  test("valid agent but unknown tier produces one issue on the tier path", () => {
    const result = withTierOrder([{ tier: "powerful", agent: "opencode", attempts: 2 }], MODELS);
    expect(result.success).toBe(false);
    if (result.success) return;
    const tierIssues = result.error.issues.filter(
      (e) => e.message.includes('"powerful"') && e.message.includes('"opencode"'),
    );
    expect(tierIssues).toHaveLength(1);
    expect(tierIssues[0].message).toMatch(/not defined for agent/);
  });

  test("tier-only rungs (no agent field) are ignored by superRefine", () => {
    const result = withTierOrder([
      { tier: "fast", attempts: 3 },
      { tier: "balanced", attempts: 2 },
    ]);
    expect(result.success).toBe(true);
  });

  test("profile with the default tier-only ladder fails with an actionable agent-qualify message", () => {
    const result = NaxConfigSchema.safeParse({
      ...DEFAULT_CONFIG,
      models: MODELS,
      routing: {
        ...DEFAULT_CONFIG.routing,
        agents: {
          enabled: true,
          strategy: "off",
          profiles: [{ id: "oc-bal", target: { agent: "opencode", model: "balanced" }, strengths: ["impl"] }],
        },
      },
      // DEFAULT_CONFIG tierOrder is tier-only: fast/balanced/powerful with no agent fields
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.message.includes("no matching rung"));
    expect(issue).toBeDefined();
    expect(issue?.message).toContain("agent-qualify");
    expect(issue?.message).toContain('"tier": "balanced", "agent": "opencode"');
  });
});

describe("autoRoute config foundation (US-001)", () => {
  test("autoRoute.enabled defaults to false", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.autoRoute.enabled).toBe(false);
  });

  test("autoRoute.minSamples defaults to 8", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.autoRoute.minSamples).toBe(8);
  });

  test("autoRoute.upgrade defaults: escalationRate 0.3, mismatchRate 0.25", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.autoRoute.upgrade.escalationRate).toBe(0.3);
    expect(config.autoRoute.upgrade.mismatchRate).toBe(0.25);
  });

  test("autoRoute.downgrade defaults: firstPassRate 0.9, escalationRate 0.05", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.autoRoute.downgrade.firstPassRate).toBe(0.9);
    expect(config.autoRoute.downgrade.escalationRate).toBe(0.05);
  });

  test("partial override preserves defaults: minSamples=20, enabled=false", () => {
    const config = NaxConfigSchema.parse({ autoRoute: { minSamples: 20 } });
    expect(config.autoRoute.minSamples).toBe(20);
    expect(config.autoRoute.enabled).toBe(false);
  });

  test("enabled rejects non-boolean values", () => {
    const result = NaxConfigSchema.safeParse({ autoRoute: { enabled: "yes" } });
    expect(result.success).toBe(false);
  });

  test("minSamples rejects values < 1", () => {
    const result = NaxConfigSchema.safeParse({ autoRoute: { minSamples: 0 } });
    expect(result.success).toBe(false);
  });

  test("upgrade rates reject values outside [0, 1]", () => {
    const negResult = NaxConfigSchema.safeParse({ autoRoute: { upgrade: { escalationRate: -0.1 } } });
    expect(negResult.success).toBe(false);
    const overResult = NaxConfigSchema.safeParse({ autoRoute: { upgrade: { mismatchRate: 1.1 } } });
    expect(overResult.success).toBe(false);
  });

  test("downgrade rates reject values outside [0, 1]", () => {
    const negResult = NaxConfigSchema.safeParse({ autoRoute: { downgrade: { firstPassRate: -0.01 } } });
    expect(negResult.success).toBe(false);
    const overResult = NaxConfigSchema.safeParse({ autoRoute: { downgrade: { escalationRate: 1.01 } } });
    expect(overResult.success).toBe(false);
  });
});

describe("ContextV2RulesConfigSchema — enforceBudget (US-002)", () => {
  function rulesConfig(rules: Record<string, unknown> | undefined) {
    if (rules === undefined) return { ...DEFAULT_CONFIG };
    return {
      ...DEFAULT_CONFIG,
      context: { ...DEFAULT_CONFIG.context, v2: { ...DEFAULT_CONFIG.context?.v2, rules } },
    };
  }

  test("[US-002 AC 11] enforceBudget defaults to true when context.v2.rules is omitted (US-003 flipped default)", () => {
    const config = NaxConfigSchema.parse(rulesConfig(undefined));
    const context = config.context as Record<string, unknown>;
    const v2 = context.v2 as Record<string, unknown>;
    const rules = v2.rules as Record<string, unknown>;
    expect(rules.enforceBudget).toBe(true);
  });

  test("[US-002 AC 11] enforceBudget defaults to true when context.v2.rules is supplied without enforceBudget (US-003 flipped default)", () => {
    const config = NaxConfigSchema.parse(rulesConfig({ budgetTokens: 4096 }));
    const context = config.context as Record<string, unknown>;
    const v2 = context.v2 as Record<string, unknown>;
    const rules = v2.rules as Record<string, unknown>;
    expect(rules.enforceBudget).toBe(true);
  });

  test("[US-002 AC 12] enforceBudget resolves to true when explicitly set true via context.v2.rules.enforceBudget", () => {
    const config = NaxConfigSchema.parse(rulesConfig({ enforceBudget: true }));
    const context = config.context as Record<string, unknown>;
    const v2 = context.v2 as Record<string, unknown>;
    const rules = v2.rules as Record<string, unknown>;
    expect(rules.enforceBudget).toBe(true);
  });

  test("enforceBudget: false is accepted as an explicit override", () => {
    const config = NaxConfigSchema.parse(rulesConfig({ enforceBudget: false }));
    const context = config.context as Record<string, unknown>;
    const v2 = context.v2 as Record<string, unknown>;
    const rules = v2.rules as Record<string, unknown>;
    expect(rules.enforceBudget).toBe(false);
  });

  test("enforceBudget rejects non-boolean values", () => {
    const result = NaxConfigSchema.safeParse(rulesConfig({ enforceBudget: "yes" }));
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003: rulesShare + flipped enforceBudget default
//
// Acceptance criteria covered here:
//   AC 1 — rulesShare defaults to 0.4 when unset
//   AC 2 — enforceBudget defaults to true when unset (covered above)
//   AC 3 — rulesShare rejects values > 1
//   AC 4 — rulesShare rejects values < 0
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextV2RulesConfigSchema — rulesShare (US-003)", () => {
  function rulesConfig(rules: Record<string, unknown> | undefined) {
    if (rules === undefined) return { ...DEFAULT_CONFIG };
    return {
      ...DEFAULT_CONFIG,
      context: { ...DEFAULT_CONFIG.context, v2: { ...DEFAULT_CONFIG.context?.v2, rules } },
    };
  }

  test("[US-003 AC 1] rulesShare defaults to 0.4 when context.v2.rules is omitted", () => {
    const config = NaxConfigSchema.parse(rulesConfig(undefined));
    const context = config.context as Record<string, unknown>;
    const v2 = context.v2 as Record<string, unknown>;
    const rules = v2.rules as Record<string, unknown>;
    expect(rules.rulesShare).toBe(0.4);
  });

  test("[US-003 AC 1] rulesShare defaults to 0.4 when context.v2.rules is supplied without rulesShare", () => {
    const config = NaxConfigSchema.parse(rulesConfig({ budgetTokens: 4096 }));
    const context = config.context as Record<string, unknown>;
    const v2 = context.v2 as Record<string, unknown>;
    const rules = v2.rules as Record<string, unknown>;
    expect(rules.rulesShare).toBe(0.4);
  });

  test("[US-003 AC 3] rulesShare rejects values above 1", () => {
    const result = NaxConfigSchema.safeParse(rulesConfig({ rulesShare: 1.5 }));
    expect(result.success).toBe(false);
  });

  test("[US-003 AC 4] rulesShare rejects negative values", () => {
    const result = NaxConfigSchema.safeParse(rulesConfig({ rulesShare: -0.1 }));
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-1496: no-progress config fields (abortOnNoProgress, consecutiveNoProgressToBail)
//
// Acceptance criteria covered here:
//   AC 1 — abortOnNoProgress default is true
//   AC 2 — consecutiveNoProgressToBail default is 3 (one higher than count bail's 2)
//   AC 3 — consecutiveNoProgressToBail rejects 0 (min 1)
//   AC 4 — consecutiveNoProgressToBail rejects 11 (max 10)
//   AC 5 — consecutiveNoProgressToBail accepts 1 (min boundary)
//   AC 6 — consecutiveNoProgressToBail accepts 10 (max boundary)
//   AC 9 — abortOnNoProgress explicit override (false) is preserved
// ─────────────────────────────────────────────────────────────────────────────

describe("RectificationConfigSchema — no-progress fields (US-1496)", () => {
  function rectificationConfig(rect: Record<string, unknown> | undefined) {
    if (rect === undefined) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, rectification: rect } };
  }

  test("[US-1496 AC 1] abortOnNoProgress defaults to true when execution.rectification is omitted", () => {
    const config = NaxConfigSchema.parse({});
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification.abortOnNoProgress).toBe(true);
  });

  test("[US-1496 AC 2] consecutiveNoProgressToBail defaults to 3 when execution.rectification is omitted", () => {
    const config = NaxConfigSchema.parse({});
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification.consecutiveNoProgressToBail).toBe(3);
  });

  test("[US-1496 AC 3] consecutiveNoProgressToBail rejects 0 (below min 1)", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ consecutiveNoProgressToBail: 0 }));
    expect(result.success).toBe(false);
  });

  test("[US-1496 AC 4] consecutiveNoProgressToBail rejects 11 (above max 10)", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ consecutiveNoProgressToBail: 11 }));
    expect(result.success).toBe(false);
  });

  test("[US-1496 AC 5] consecutiveNoProgressToBail accepts 1 (min boundary)", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ consecutiveNoProgressToBail: 1 }));
    expect(result.success).toBe(true);
  });

  test("[US-1496 AC 6] consecutiveNoProgressToBail accepts 10 (max boundary)", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ consecutiveNoProgressToBail: 10 }));
    expect(result.success).toBe(true);
  });

  test("[US-1496 AC 9] abortOnNoProgress explicit override to false is preserved", () => {
    const config = NaxConfigSchema.parse(rectificationConfig({ abortOnNoProgress: false }));
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification.abortOnNoProgress).toBe(false);
  });

  /**
   * The default is declared in TWO places that Zod never reconciles: the parent
   * literal in `schemas.ts` (which `parse({})` resolves) and `.default(true)` on
   * the nested field in `schemas-execution.ts` (which only a PARTIAL
   * `execution.rectification` reaches). AC 1 above covers the first; without
   * this the second can be flipped and every test still passes, letting the two
   * sites drift silently.
   *
   * Found by the mutation spot-check: a `ts:bool-flip` on the nested default
   * survived a real run.
   */
  test("abortOnNoProgress defaults to true when rectification is present but omits it", () => {
    const config = NaxConfigSchema.parse(rectificationConfig({ maxAttemptsTotal: 5 }));
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification.abortOnNoProgress).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004: storyScopedFixBudget config field (run-scoped story fix history)
//
// Acceptance criteria covered here:
//   AC 1 — storyScopedFixBudget defaults to true when unset
//   AC 2 — storyScopedFixBudget = false is preserved when project config sets it
//   AC 3 — string "yes" fails validation without coercing to boolean
// ─────────────────────────────────────────────────────────────────────────────

describe("RectificationConfigSchema — storyScopedFixBudget (US-004)", () => {
  function rectificationConfig(rect: Record<string, unknown> | undefined) {
    if (rect === undefined) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, rectification: rect } };
  }

  test("[US-004 AC 1] storyScopedFixBudget defaults to true when execution.rectification is omitted", () => {
    const config = NaxConfigSchema.parse({});
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification.storyScopedFixBudget).toBe(true);
  });

  test("[US-004 AC 1] storyScopedFixBudget defaults to true when execution.rectification is supplied without storyScopedFixBudget", () => {
    const config = NaxConfigSchema.parse(rectificationConfig({ enabled: true, maxAttemptsTotal: 5 }));
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification.storyScopedFixBudget).toBe(true);
  });

  test("[US-004 AC 2] storyScopedFixBudget explicit override to false is preserved", () => {
    const config = NaxConfigSchema.parse(rectificationConfig({ storyScopedFixBudget: false }));
    const execution = config.execution as Record<string, unknown>;
    const rectification = execution.rectification as Record<string, unknown>;
    expect(rectification.storyScopedFixBudget).toBe(false);
  });

  test("[US-004 AC 3] storyScopedFixBudget rejects string 'yes' (no boolean coercion)", () => {
    const result = NaxConfigSchema.safeParse(rectificationConfig({ storyScopedFixBudget: "yes" }));
    expect(result.success).toBe(false);
  });
});
