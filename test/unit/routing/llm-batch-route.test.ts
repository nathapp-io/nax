import { describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import type { IAgentManager } from "../../../src/agents";
import type { UserStory } from "../../../src/prd/types";
import { tryLlmBatchRoute } from "../../../src/routing/router";

function makeConfig(): NaxConfig {
  return {
    version: 1,
    models: {
      claude: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
        powerful: { provider: "anthropic", model: "claude-opus-4-5" },
      },
    },
    autoMode: {
      enabled: true,
      defaultAgent: "claude",
      fallbackOrder: ["claude"],
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: { enabled: false, tierOrder: [{ tier: "fast", attempts: 3 }] },
    },
    analyze: {
      llmEnhanced: true,
      model: "balanced",
      fallbackToKeywords: true,
      maxCodebaseSummaryTokens: 5000,
    },
    routing: {
      strategy: "llm",
      adaptive: { minSamples: 10, costThreshold: 0.8, fallbackStrategy: "keyword" },
      llm: { model: "fast", fallbackToKeywords: true, cacheDecisions: false, mode: "hybrid", timeoutMs: 5000 },
    },
    execution: {
      maxIterations: 5,
      iterationDelayMs: 0,
      costLimit: 10,
      sessionTimeoutSeconds: 60,
      verificationTimeoutSeconds: 60,
      maxStoriesPerFeature: 100,
      rectification: {
        enabled: false,
        maxRetries: 1,
        fullSuiteTimeoutSeconds: 60,
        maxFailureSummaryChars: 1000,
        abortOnIncreasingFailures: false,
      },
      regressionGate: { enabled: false, timeoutSeconds: 60, acceptOnTimeout: true, maxRectificationAttempts: 1 },
      contextProviderTokenBudget: 1000,
      smartTestRunner: false,
    },
    quality: {
      requireTypecheck: false,
      requireLint: false,
      requireTests: false,
      commands: {},
      forceExit: false,
      detectOpenHandles: false,
      detectOpenHandlesRetries: 0,
      gracePeriodMs: 0,
      dangerouslySkipPermissions: true,
      drainTimeoutMs: 0,
      shell: "/bin/sh",
      stripEnvVars: [],
    },
    tdd: {
      maxRetries: 1,
      autoVerifyIsolation: false,
      autoApproveVerifier: true,
      strategy: "off",
      sessionTiers: { testWriter: "fast", verifier: "fast" },
      testWriterAllowedPaths: [],
      rollbackOnFailure: false,
      greenfieldDetection: false,
    },
    constitution: { enabled: false, path: "constitution.md", maxTokens: 0 },
    review: { enabled: false, checks: [], commands: {} },
    plan: { model: "balanced", outputPath: "spec.md" },
    acceptance: { enabled: false, maxRetries: 1, generateTests: false, testPath: "acceptance.test.ts" },
    context: {
      fileInjection: "disabled",
      testCoverage: {
        enabled: false,
        detail: "names-and-counts",
        maxTokens: 0,
        testPattern: "**/*.test.ts",
        scopeToStory: false,
      },
      autoDetect: { enabled: false, maxFiles: 0, traceImports: false },
    },
    interaction: {
      plugin: "cli",
      config: {},
      defaults: { timeout: 1000, fallback: "escalate" },
      triggers: {},
    },
    precheck: {
      storySizeGate: { enabled: false, maxAcCount: 10, maxDescriptionLength: 5000, maxBulletPoints: 20 },
    },
    prompts: {},
    decompose: {
      trigger: "disabled",
      maxAcceptanceCriteria: 6,
      maxSubstories: 5,
      maxSubstoryComplexity: "medium",
      maxRetries: 1,
      model: "balanced",
    },
  };
}

function makeStory(): UserStory {
  return {
    id: "US-001",
    title: "Story",
    description: "desc",
    acceptanceCriteria: ["ac"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

describe("tryLlmBatchRoute", () => {
  test("passes name and config into _deps.createManager", async () => {
    const config = makeConfig();
    const story = makeStory();
    let capturedConfig: NaxConfig | undefined;

    const deps = {
      createManager: mock((cfg: NaxConfig): IAgentManager => {
        capturedConfig = cfg;
        return undefined as unknown as IAgentManager;
      }),
    };

    await tryLlmBatchRoute(config, [story], "routing", deps);

    expect(capturedConfig).toBe(config);
  });

  test("does not call _deps.createManager when no stories require routing", async () => {
    const config = makeConfig();
    const story: UserStory = {
      ...makeStory(),
      routing: {
        complexity: "simple",
        modelTier: "fast",
        testStrategy: "test-after",
        reasoning: "already routed",
      },
    };

    const deps = {
      createManager: mock((_cfg: NaxConfig): IAgentManager => undefined as unknown as IAgentManager),
    };

    await tryLlmBatchRoute(config, [story], "routing", deps);

    expect(deps.createManager).toHaveBeenCalledTimes(0);
  });
});
