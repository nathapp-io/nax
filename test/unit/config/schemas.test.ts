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
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

/** Minimal valid config base — everything except models */
function baseConfig(models: unknown): Record<string, unknown> {
  return {
    ...(DEFAULT_CONFIG as Record<string, unknown>),
    models,
  };
}

describe("ModelsSchema — legacy flat config migration", () => {
  test("auto-migrates legacy flat ModelDef object to per-agent shape using defaultAgent", () => {
    const legacy = {
      fast: { provider: "anthropic", model: "haiku" },
      balanced: { provider: "anthropic", model: "sonnet" },
      powerful: { provider: "anthropic", model: "opus" },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(legacy));

    expect(result.success).toBe(true);
    if (!result.success) return;

    const defaultAgent = (DEFAULT_CONFIG as { autoMode: { defaultAgent: string } }).autoMode.defaultAgent;
    const models = result.data.models as Record<string, unknown>;

    // Top-level keys should be agent names, not tier names
    expect(models[defaultAgent]).toBeDefined();
    expect(models["fast"]).toBeUndefined();
    expect(models["balanced"]).toBeUndefined();
    expect(models["powerful"]).toBeUndefined();
  });

  test("migrated per-agent config contains the original tier entries under defaultAgent", () => {
    const legacy = {
      fast: { provider: "anthropic", model: "haiku" },
      balanced: { provider: "anthropic", model: "sonnet" },
      powerful: { provider: "anthropic", model: "opus" },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(legacy));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const defaultAgent = (DEFAULT_CONFIG as { autoMode: { defaultAgent: string } }).autoMode.defaultAgent;
    const models = result.data.models as Record<string, Record<string, unknown>>;
    const agentMap = models[defaultAgent];

    expect(agentMap).toBeDefined();
    expect(agentMap["fast"]).toEqual({ provider: "anthropic", model: "haiku" });
    expect(agentMap["balanced"]).toEqual({ provider: "anthropic", model: "sonnet" });
    expect(agentMap["powerful"]).toEqual({ provider: "anthropic", model: "opus" });
  });

  test("auto-migrates legacy flat string model entries to per-agent shape using defaultAgent", () => {
    const legacy = {
      fast: "claude-haiku-4-5",
      balanced: "claude-sonnet-4-5",
      powerful: "claude-opus-4-5",
    };

    const result = NaxConfigSchema.safeParse(baseConfig(legacy));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const defaultAgent = (DEFAULT_CONFIG as { autoMode: { defaultAgent: string } }).autoMode.defaultAgent;
    const models = result.data.models as Record<string, Record<string, unknown>>;

    expect(models[defaultAgent]).toBeDefined();
    expect(models["fast"]).toBeUndefined();
  });

  test("migrated string model entries are preserved under defaultAgent", () => {
    const legacy = {
      fast: "claude-haiku-4-5",
      balanced: "claude-sonnet-4-5",
    };

    const result = NaxConfigSchema.safeParse(baseConfig(legacy));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const defaultAgent = (DEFAULT_CONFIG as { autoMode: { defaultAgent: string } }).autoMode.defaultAgent;
    const models = result.data.models as Record<string, Record<string, unknown>>;
    const agentMap = models[defaultAgent];

    expect(agentMap["fast"]).toBe("claude-haiku-4-5");
    expect(agentMap["balanced"]).toBe("claude-sonnet-4-5");
  });

  test("detection: value with 'provider' key directly triggers legacy migration", () => {
    const legacy = {
      fast: { provider: "anthropic", model: "haiku" },
    };

    const result = NaxConfigSchema.safeParse(baseConfig(legacy));
    expect(result.success).toBe(true);
    if (!result.success) return;

    // After migration, top-level should not have tier names
    const models = result.data.models as Record<string, unknown>;
    expect(models["fast"]).toBeUndefined();
  });

  test("detection: string value at top level triggers legacy migration", () => {
    const legacy = {
      fast: "claude-haiku",
    };

    const result = NaxConfigSchema.safeParse(baseConfig(legacy));
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, unknown>;
    expect(models["fast"]).toBeUndefined();
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
    expect(models["claude"]).toBeDefined();
    expect(models["codex"]).toBeDefined();
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
    expect(models["claude"]["fast"]).toBe("haiku");
    expect(models["claude"]["balanced"]).toBe("sonnet");
    expect(models["claude"]["powerful"]).toBe("opus");
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
    expect(models["codex"]["fast"]).toBe("gpt-5");
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
    expect(models["claude"]["fast"]).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
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
    expect(models["fast"]).toBeUndefined();
    expect(models["balanced"]).toBeUndefined();
    expect(models["powerful"]).toBeUndefined();
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
    expect(models["claude"]["fast"]).toBe("haiku");
    expect(models["claude"]["balanced"]).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
  });
});

describe("StorySizeGateConfigSchema — action and maxReplanAttempts (US-001)", () => {
  function basePrecheckConfig(storySizeGate: Record<string, unknown>): Record<string, unknown> {
    return {
      ...(DEFAULT_CONFIG as Record<string, unknown>),
      precheck: { storySizeGate },
    };
  }

  test("action defaults to 'block' when omitted", () => {
    const config = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      maxReplanAttempts: 3,
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const gate = (result.data as Record<string, unknown>).precheck as Record<string, unknown>;
    const ssg = gate.storySizeGate as Record<string, unknown>;
    expect(ssg.action).toBe("block");
  });

  test("action accepts 'warn'", () => {
    const config = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      maxReplanAttempts: 3,
      action: "warn",
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("action accepts 'skip'", () => {
    const config = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      maxReplanAttempts: 3,
      action: "skip",
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("action rejects invalid values", () => {
    const config = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      maxReplanAttempts: 3,
      action: "invalid",
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("maxReplanAttempts defaults to 3 when omitted", () => {
    const config = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      action: "block",
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const gate = (result.data as Record<string, unknown>).precheck as Record<string, unknown>;
    const ssg = gate.storySizeGate as Record<string, unknown>;
    expect(ssg.maxReplanAttempts).toBe(3);
  });

  test("maxReplanAttempts rejects 0 (must be >= 1)", () => {
    const config = basePrecheckConfig({
      enabled: true,
      maxAcCount: 10,
      maxDescriptionLength: 3000,
      maxBulletPoints: 12,
      action: "block",
      maxReplanAttempts: 0,
    });
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("ModelsSchema — DEFAULT_CONFIG compatibility", () => {
  test("DEFAULT_CONFIG (legacy flat format) parses successfully after migration", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG as Record<string, unknown>);
    expect(result.success).toBe(true);
  });

  test("DEFAULT_CONFIG after migration has per-agent structure", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG as Record<string, unknown>);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const models = result.data.models as Record<string, unknown>;
    // Should contain agent key (defaultAgent = "claude"), not tier keys
    expect(models["claude"]).toBeDefined();
  });
});

describe("profile field — US-001-A", () => {
  test("NaxConfigSchema.parse({}).profile equals 'default'", () => {
    const result = NaxConfigSchema.safeParse(DEFAULT_CONFIG as Record<string, unknown>);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const profile = (result.data as Record<string, unknown>).profile as string;
    expect(profile).toBe("default");
  });

  test("NaxConfigSchema.parse({ profile: 'fast' }).profile equals 'fast'", () => {
    const config = {
      ...(DEFAULT_CONFIG as Record<string, unknown>),
      profile: "fast",
    };

    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const profile = (result.data as Record<string, unknown>).profile as string;
    expect(profile).toBe("fast");
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

  test("stages.plan.mode defaults to 'panel'", () => {
    expect(getStages().plan.mode).toBe("panel");
  });

  test("stages.review.mode defaults to 'panel'", () => {
    expect(getStages().review.mode).toBe("panel");
  });

  test("stages.acceptance.mode defaults to 'panel'", () => {
    expect(getStages().acceptance.mode).toBe("panel");
  });

  test("stages.rectification.mode defaults to 'panel'", () => {
    expect(getStages().rectification.mode).toBe("panel");
  });

  test("stages.escalation.mode defaults to 'panel'", () => {
    expect(getStages().escalation.mode).toBe("panel");
  });

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
  test("NaxConfigSchema.parse({}).quality.scopeTestThreshold === 10", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.quality.scopeTestThreshold).toBe(10);
  });

  test("NaxConfigSchema.parse({ quality: { scopeTestThreshold: 5 } }).quality.scopeTestThreshold === 5", () => {
    const result = NaxConfigSchema.parse({ quality: { scopeTestThreshold: 5 } });
    expect(result.quality.scopeTestThreshold).toBe(5);
  });

  test("scopeTestThreshold rejects negative values", () => {
    const result = NaxConfigSchema.safeParse({ quality: { scopeTestThreshold: -1 } });
    expect(result.success).toBe(false);
  });

  test("scopeTestThreshold accepts zero", () => {
    const result = NaxConfigSchema.parse({ quality: { scopeTestThreshold: 0 } });
    expect(result.quality.scopeTestThreshold).toBe(0);
  });

  test("scopeTestThreshold accepts large values", () => {
    const result = NaxConfigSchema.parse({ quality: { scopeTestThreshold: 1000 } });
    expect(result.quality.scopeTestThreshold).toBe(1000);
  });
});
