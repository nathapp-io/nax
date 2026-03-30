/**
 * Debate Config Schema Tests
 *
 * Tests for the debate config section in NaxConfigSchema and DEFAULT_CONFIG.
 * Covers AC-1 through AC-7 from US-001.
 */

import { describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { FIELD_DESCRIPTIONS } from "../../../src/cli/config-descriptions";

// Minimal valid base config — debate key intentionally absent
const baseConfig = {
  version: 1,
  models: {
    claude: {
      fast: { provider: "anthropic", model: "haiku" },
      balanced: { provider: "anthropic", model: "sonnet" },
      powerful: { provider: "anthropic", model: "opus" },
    },
  },
  autoMode: {
    enabled: true,
    defaultAgent: "claude",
    fallbackOrder: ["claude"],
    complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
    escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 5 }] },
  },
  routing: { strategy: "keyword" },
  execution: {
    maxIterations: 10,
    iterationDelayMs: 0,
    costLimit: 1,
    sessionTimeoutSeconds: 60,
    maxStoriesPerFeature: 10,
    rectification: {
      enabled: true,
      maxRetries: 2,
      fullSuiteTimeoutSeconds: 60,
      maxFailureSummaryChars: 500,
      abortOnIncreasingFailures: true,
      escalateOnExhaustion: true,
      rethinkAtAttempt: 2,
      urgencyAtAttempt: 3,
    },
    regressionGate: {
      enabled: true,
      timeoutSeconds: 60,
    },
  },
  quality: {
    requireTypecheck: false,
    requireLint: false,
    requireTests: false,
    commands: {},
  },
  tdd: { maxRetries: 1, autoVerifyIsolation: false, autoApproveVerifier: false },
  constitution: { enabled: false, path: "constitution.md", maxTokens: 100 },
  analyze: { llmEnhanced: false, model: "fast", fallbackToKeywords: true, maxCodebaseSummaryTokens: 100 },
  review: { enabled: false, checks: [], commands: {} },
  plan: { model: "balanced", outputPath: "spec.md" },
  acceptance: { enabled: false, maxRetries: 0, generateTests: false, testPath: "acceptance.test.ts" },
  context: {
    testCoverage: { enabled: false, detail: "names-only", maxTokens: 100, testPattern: "**/*.test.ts", scopeToStory: false },
    autoDetect: { enabled: false, maxFiles: 5, traceImports: false },
  },
};

describe("debate config schema — AC-1: defaults when debate key is absent", () => {
  test("debate.enabled defaults to false", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.debate?.enabled).toBe(false);
  });

  test("debate.agents defaults to 3", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.debate?.agents).toBe(3);
  });

  test("plan stage defaults: stateful, synthesis, 3 rounds, enabled", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const plan = result.data.debate?.stages.plan;
    expect(plan?.sessionMode).toBe("stateful");
    expect(plan?.resolver.type).toBe("synthesis");
    expect(plan?.rounds).toBe(3);
    expect(plan?.enabled).toBe(true);
  });

  test("review stage defaults: one-shot, majority-fail-closed, 2 rounds, enabled", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const review = result.data.debate?.stages.review;
    expect(review?.sessionMode).toBe("one-shot");
    expect(review?.resolver.type).toBe("majority-fail-closed");
    expect(review?.rounds).toBe(2);
    expect(review?.enabled).toBe(true);
  });

  test("acceptance stage defaults: one-shot, majority-fail-closed, 1 round, disabled", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const acceptance = result.data.debate?.stages.acceptance;
    expect(acceptance?.sessionMode).toBe("one-shot");
    expect(acceptance?.resolver.type).toBe("majority-fail-closed");
    expect(acceptance?.rounds).toBe(1);
    expect(acceptance?.enabled).toBe(false);
  });

  test("rectification stage defaults: one-shot, synthesis, 1 round, disabled", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const rectification = result.data.debate?.stages.rectification;
    expect(rectification?.sessionMode).toBe("one-shot");
    expect(rectification?.resolver.type).toBe("synthesis");
    expect(rectification?.rounds).toBe(1);
    expect(rectification?.enabled).toBe(false);
  });

  test("escalation stage defaults: one-shot, majority-fail-closed, 1 round, disabled", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const escalation = result.data.debate?.stages.escalation;
    expect(escalation?.sessionMode).toBe("one-shot");
    expect(escalation?.resolver.type).toBe("majority-fail-closed");
    expect(escalation?.rounds).toBe(1);
    expect(escalation?.enabled).toBe(false);
  });
});

describe("debate config schema — AC-2: no agent/model fields when not specified", () => {
  test("no resolver.agent when not specified", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.debate?.stages.plan.resolver.agent).toBeUndefined();
  });

  test("no debaters array when not specified", () => {
    const result = NaxConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.debate?.stages.plan.debaters).toBeUndefined();
  });
});

describe("debate config schema — AC-3: debaters array fewer than 2 entries", () => {
  test("returns validation error with 'debaters must have at least 2 entries'", () => {
    const config = {
      ...baseConfig,
      debate: {
        enabled: true,
        stages: {
          plan: {
            debaters: [{ agent: "claude" }],
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("debaters must have at least 2 entries"))).toBe(true);
  });

  test("empty debaters array also fails", () => {
    const config = {
      ...baseConfig,
      debate: {
        enabled: true,
        stages: { plan: { debaters: [] } },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((i) => i.message);
    expect(messages.some((m) => m.includes("debaters must have at least 2 entries"))).toBe(true);
  });
});

describe("debate config schema — AC-4: invalid resolver type", () => {
  test("returns validation error when resolver.type is invalid", () => {
    const config = {
      ...baseConfig,
      debate: {
        enabled: true,
        stages: {
          plan: {
            resolver: { type: "invalid" },
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});

describe("debate config schema — AC-5: partial stage config falls back to per-stage defaults", () => {
  test("specifying only resolver merges with plan stage defaults", () => {
    const config = {
      ...baseConfig,
      debate: {
        enabled: true,
        stages: {
          plan: {
            resolver: { type: "synthesis" },
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const plan = result.data.debate?.stages.plan;
    // Remaining fields fall back to plan stage defaults
    expect(plan?.sessionMode).toBe("stateful");
    expect(plan?.rounds).toBe(3);
    expect(plan?.enabled).toBe(true);
  });
});

describe("debate config schema — AC-6: debater with agent but no model is valid", () => {
  test("debater with only agent field is valid", () => {
    const config = {
      ...baseConfig,
      debate: {
        enabled: true,
        stages: {
          plan: {
            debaters: [{ agent: "claude" }, { agent: "opencode" }],
          },
        },
      },
    };
    const result = NaxConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const debaters = result.data.debate?.stages.plan.debaters;
    expect(debaters?.[0].agent).toBe("claude");
    expect(debaters?.[0].model).toBeUndefined();
  });
});

describe("debate config schema — AC-7: FIELD_DESCRIPTIONS contains debate entries", () => {
  test("debate top-level description exists", () => {
    expect(FIELD_DESCRIPTIONS["debate"]).toBeDefined();
    expect(typeof FIELD_DESCRIPTIONS["debate"]).toBe("string");
  });

  test("debate.enabled description exists", () => {
    expect(FIELD_DESCRIPTIONS["debate.enabled"]).toBeDefined();
  });

  test("debate.agents description exists", () => {
    expect(FIELD_DESCRIPTIONS["debate.agents"]).toBeDefined();
  });

  test("debate.stages.plan description exists", () => {
    expect(FIELD_DESCRIPTIONS["debate.stages.plan"]).toBeDefined();
  });

  test("debate.stages.plan.resolver.type description exists", () => {
    expect(FIELD_DESCRIPTIONS["debate.stages.plan.resolver.type"]).toBeDefined();
  });

  test("debate.stages.plan.sessionMode description exists", () => {
    expect(FIELD_DESCRIPTIONS["debate.stages.plan.sessionMode"]).toBeDefined();
  });

  test("debate.stages.plan.rounds description exists", () => {
    expect(FIELD_DESCRIPTIONS["debate.stages.plan.rounds"]).toBeDefined();
  });
});

describe("DEFAULT_CONFIG includes debate section", () => {
  test("debate.enabled is false by default", () => {
    expect(DEFAULT_CONFIG.debate?.enabled).toBe(false);
  });

  test("debate.agents is 3 by default", () => {
    expect(DEFAULT_CONFIG.debate?.agents).toBe(3);
  });

  test("plan stage has stateful sessionMode", () => {
    expect(DEFAULT_CONFIG.debate?.stages.plan.sessionMode).toBe("stateful");
  });

  test("review stage has one-shot sessionMode", () => {
    expect(DEFAULT_CONFIG.debate?.stages.review.sessionMode).toBe("one-shot");
  });
});
