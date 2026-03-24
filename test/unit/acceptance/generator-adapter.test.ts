/**
 * Tests for ACP-001: Fix acceptance generators to use adapter.complete()
 *
 * Covers:
 * - generateAcceptanceTests calls adapter.complete() instead of Bun.spawn
 * - generateFixStories calls adapter.complete() instead of Bun.spawn
 * - Neither function references adapter.binary for LLM calls
 * - Correct prompt and model are passed to adapter.complete()
 * - Error fallback behavior is preserved when adapter.complete() throws
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { generateAcceptanceTests } from "../../../src/acceptance/generator";
import { generateFixStories } from "../../../src/acceptance/fix-generator";
import type { GenerateAcceptanceTestsOptions } from "../../../src/acceptance/types";
import type { GenerateFixStoriesOptions } from "../../../src/acceptance/fix-generator";
import type { AgentAdapter, CompleteOptions } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { PRD } from "../../../src/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeConfig(): NaxConfig {
  return {
    version: 1,
    models: {
      fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
      powerful: { provider: "anthropic", model: "claude-opus-4-5" },
    },
    autoMode: {
      enabled: true,
      defaultAgent: "claude",
      fallbackOrder: ["claude"],
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: { enabled: false, tierOrder: [{ tier: "fast", attempts: 3 }] },
    },
    analyze: {
      llmEnhanced: false,
      model: "balanced",
      fallbackToKeywords: true,
      maxCodebaseSummaryTokens: 5000,
    },
    routing: {
      strategy: "keyword",
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
    acceptance: {
      enabled: true,
      maxRetries: 1,
      generateTests: false,
      testPath: "acceptance.test.ts",
      model: "fast",
      refinement: false,
      redGate: false,
    },
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

const SPEC_WITH_ACS = `# Feature

## Acceptance Criteria
- AC-1: system handles empty input gracefully
- AC-2: set(key, value, ttl) expires after ttl milliseconds
- AC-3: validates format before processing
`;

const MODEL_DEF = { provider: "anthropic" as const, model: "claude-haiku-4-5-20251001" };

const SAMPLE_TEST_CODE = `import { describe, test, expect } from "bun:test";

describe("feature - Acceptance Tests", () => {
  test("AC-1: system handles empty input gracefully", async () => {
    expect(true).toBe(true);
  });
});
`;

function makeMockAdapter(completeResponse = SAMPLE_TEST_CODE): {
  adapter: AgentAdapter;
  completeCalls: Array<{ prompt: string; options?: CompleteOptions }>;
} {
  const completeCalls: Array<{ prompt: string; options?: CompleteOptions }> = [];

  const adapter = {
    name: "mock",
    displayName: "Mock Adapter",
    binary: "mock-binary",
    capabilities: {
      supportedTiers: ["fast" as const],
      maxContextTokens: 100000,
      features: new Set(["tdd" as const, "review" as const, "refactor" as const, "batch" as const]),
    },
    isInstalled: mock(async () => true),
    run: mock(async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCost: 0,
    })),
    buildCommand: mock(() => []),
    plan: mock(async () => ({ spec: "", rawOutput: "" })),
    decompose: mock(async () => ({ stories: [], rawOutput: "" })),
    complete: mock(async (prompt: string, options?: CompleteOptions) => {
      completeCalls.push({ prompt, options });
      return completeResponse;
    }),
  } as unknown as AgentAdapter;

  return { adapter, completeCalls };
}

function makeGenerateOptions(): GenerateAcceptanceTestsOptions {
  return {
    specContent: SPEC_WITH_ACS,
    featureName: "url-shortener",
    workdir: "/tmp/test-workdir",
    codebaseContext: "File tree:\nsrc/\n  index.ts\n",
    modelTier: "fast",
    modelDef: MODEL_DEF,
    config: makeConfig(),
  };
}

const SAMPLE_PRD: PRD = {
  project: "test",
  feature: "url-shortener",
  branchName: "feat/url-shortener",
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
  userStories: [
    {
      id: "US-001",
      title: "Implement URL shortening",
      description: "Add URL shortening capability",
      acceptanceCriteria: ["AC-2: TTL expiry"],
      tags: [],
      dependencies: [],
      status: "passed",
      passes: true,
      escalations: [],
      attempts: 0,
      contextFiles: [],
    },
  ],
};

function makeFixOptions(): GenerateFixStoriesOptions {
  return {
    failedACs: ["AC-2"],
    testOutput: "Expected undefined, got 'value'\n  at test:5:3",
    prd: SAMPLE_PRD,
    specContent: SPEC_WITH_ACS,
    workdir: "/tmp/test-workdir",
    modelDef: MODEL_DEF,
    config: makeConfig(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests — generateAcceptanceTests
// ─────────────────────────────────────────────────────────────────────────────

describe("generateAcceptanceTests — adapter.complete() integration", () => {
  let originalSpawn: typeof Bun.spawn;
  const spawnCalls: unknown[][] = [];

  afterEach(() => {
    if (originalSpawn) {
      (Bun as { spawn: unknown }).spawn = originalSpawn;
    }
    spawnCalls.length = 0;
    mock.restore();
  });

  test("calls adapter.complete() for LLM generation instead of Bun.spawn", async () => {
    const { adapter, completeCalls } = makeMockAdapter();
    const options = makeGenerateOptions();

    // Intercept Bun.spawn to detect if it's called directly
    originalSpawn = Bun.spawn;
    (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
      spawnCalls.push(args);
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    };

    await generateAcceptanceTests(adapter, options);

    // adapter.complete() must be called at least once
    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT call Bun.spawn directly for LLM calls", async () => {
    const { adapter } = makeMockAdapter();
    const options = makeGenerateOptions();

    originalSpawn = Bun.spawn;
    (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
      spawnCalls.push(args);
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    };

    await generateAcceptanceTests(adapter, options);

    expect(spawnCalls).toHaveLength(0);
  });

  test("passes a plain string prompt to adapter.complete()", async () => {
    const { adapter, completeCalls } = makeMockAdapter();
    const options = makeGenerateOptions();

    await generateAcceptanceTests(adapter, options);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    expect(typeof completeCalls[0].prompt).toBe("string");
    expect(completeCalls[0].prompt.length).toBeGreaterThan(0);
  });

  test("prompt passed to adapter.complete() contains all AC identifiers", async () => {
    const { adapter, completeCalls } = makeMockAdapter();
    const options = makeGenerateOptions();

    await generateAcceptanceTests(adapter, options);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    const prompt = completeCalls[0].prompt;
    expect(prompt).toContain("AC-1");
    expect(prompt).toContain("AC-2");
    expect(prompt).toContain("AC-3");
  });

  test("passes model from modelDef to adapter.complete()", async () => {
    const { adapter, completeCalls } = makeMockAdapter();
    const options = makeGenerateOptions();

    await generateAcceptanceTests(adapter, options);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    expect(completeCalls[0].options?.model).toBe(MODEL_DEF.model);
  });

  test("returns generated test code from adapter.complete() response", async () => {
    const { adapter } = makeMockAdapter(SAMPLE_TEST_CODE);
    const options = makeGenerateOptions();

    const result = await generateAcceptanceTests(adapter, options);

    expect(typeof result.testCode).toBe("string");
    expect(result.testCode.length).toBeGreaterThan(0);
  });

  test("returns criteria matching the ACs found in spec", async () => {
    const { adapter } = makeMockAdapter();
    const options = makeGenerateOptions();

    const result = await generateAcceptanceTests(adapter, options);

    expect(result.criteria.length).toBe(3);
    expect(result.criteria[0].id).toBe("AC-1");
    expect(result.criteria[1].id).toBe("AC-2");
    expect(result.criteria[2].id).toBe("AC-3");
  });

  test("falls back to skeleton tests when adapter.complete() throws", async () => {
    const { adapter } = makeMockAdapter();
    (adapter.complete as ReturnType<typeof mock>) = mock(async () => {
      throw new Error("LLM unavailable");
    });

    const options = makeGenerateOptions();
    const result = await generateAcceptanceTests(adapter, options);

    // Should return skeleton tests, not throw
    expect(typeof result.testCode).toBe("string");
    expect(result.testCode).toContain("describe");
    expect(result.criteria.length).toBe(3);
  });

  test("does not reference adapter.binary in the LLM call path", async () => {
    const { adapter, completeCalls } = makeMockAdapter();

    // Poison adapter.binary to detect if it's accessed for spawning
    let binaryAccessed = false;
    const adapterWithSpy = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop === "binary") {
          binaryAccessed = true;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const options = makeGenerateOptions();
    await generateAcceptanceTests(adapterWithSpy as AgentAdapter, options);

    // complete() must have been called
    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    // binary must not have been read for spawning purposes (should be accessed 0 times)
    expect(binaryAccessed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests — generateFixStories
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFixStories — adapter.complete() integration", () => {
  let originalSpawn: typeof Bun.spawn;
  const spawnCalls: unknown[][] = [];

  afterEach(() => {
    if (originalSpawn) {
      (Bun as { spawn: unknown }).spawn = originalSpawn;
    }
    spawnCalls.length = 0;
    mock.restore();
  });

  test("calls adapter.complete() for LLM generation instead of Bun.spawn", async () => {
    const { adapter, completeCalls } = makeMockAdapter("Fix the TTL implementation to expire entries correctly.");
    const options = makeFixOptions();

    originalSpawn = Bun.spawn;
    (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
      spawnCalls.push(args);
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    };

    await generateFixStories(adapter, options);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("does NOT call Bun.spawn directly for LLM calls", async () => {
    const { adapter } = makeMockAdapter("Fix the TTL implementation to expire entries correctly.");
    const options = makeFixOptions();

    originalSpawn = Bun.spawn;
    (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
      spawnCalls.push(args);
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    };

    await generateFixStories(adapter, options);

    expect(spawnCalls).toHaveLength(0);
  });

  test("passes a plain string prompt to adapter.complete()", async () => {
    const { adapter, completeCalls } = makeMockAdapter("Fix the TTL implementation.");
    const options = makeFixOptions();

    await generateFixStories(adapter, options);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    expect(typeof completeCalls[0].prompt).toBe("string");
    expect(completeCalls[0].prompt.length).toBeGreaterThan(0);
  });

  test("prompt passed to adapter.complete() contains the failed AC identifier", async () => {
    const { adapter, completeCalls } = makeMockAdapter("Fix the TTL implementation.");
    const options = makeFixOptions();

    await generateFixStories(adapter, options);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    expect(completeCalls[0].prompt).toContain("AC-2");
  });

  test("passes model from modelDef to adapter.complete()", async () => {
    const { adapter, completeCalls } = makeMockAdapter("Fix the TTL implementation.");
    const options = makeFixOptions();

    await generateFixStories(adapter, options);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    expect(completeCalls[0].options?.model).toBe(MODEL_DEF.model);
  });

  test("returns FixStory[] with description from adapter.complete() response", async () => {
    const fixDesc = "Fix the TTL implementation to expire entries correctly after the specified duration.";
    const { adapter } = makeMockAdapter(fixDesc);
    const options = makeFixOptions();

    const result = await generateFixStories(adapter, options);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].description).toBe(fixDesc);
  });

  test("fix story has correct failedAC and id format", async () => {
    const { adapter } = makeMockAdapter("Fix the TTL implementation.");
    const options = makeFixOptions();

    const result = await generateFixStories(adapter, options);

    expect(result[0].failedAC).toBe("AC-2");
    expect(result[0].id).toBe("US-FIX-001");
  });

  test("falls back to default description when adapter.complete() throws", async () => {
    const { adapter } = makeMockAdapter();
    (adapter.complete as ReturnType<typeof mock>) = mock(async () => {
      throw new Error("LLM unavailable");
    });

    const options = makeFixOptions();
    const result = await generateFixStories(adapter, options);

    // Should return fallback fix story, not throw
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(1);
    expect(result[0].failedAC).toBe("AC-2");
    expect(typeof result[0].description).toBe("string");
    expect(result[0].description.length).toBeGreaterThan(0);
  });

  test("does not reference adapter.binary in the LLM call path", async () => {
    const { adapter, completeCalls } = makeMockAdapter("Fix the TTL implementation.");

    let binaryAccessed = false;
    const adapterWithSpy = new Proxy(adapter, {
      get(target, prop, receiver) {
        if (prop === "binary") {
          binaryAccessed = true;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const options = makeFixOptions();
    await generateFixStories(adapterWithSpy as AgentAdapter, options);

    expect(completeCalls.length).toBeGreaterThanOrEqual(1);
    expect(binaryAccessed).toBe(false);
  });

  test("calls adapter.complete() once per AC group (batched — D1)", async () => {
    const { adapter, completeCalls } = makeMockAdapter("Fix it.");

    // All 3 ACs belong to the same story → grouped into 1 batch → 1 LLM call
    const options: GenerateFixStoriesOptions = {
      ...makeFixOptions(),
      failedACs: ["AC-1", "AC-2", "AC-3"],
      prd: {
        ...SAMPLE_PRD,
        userStories: [
          {
            ...SAMPLE_PRD.userStories[0],
            acceptanceCriteria: ["AC-1: first", "AC-2: second", "AC-3: third"],
          },
        ],
      },
    };

    await generateFixStories(adapter, options);

    // D1: ACs sharing the same related story are batched into 1 fix story → 1 LLM call
    expect(completeCalls.length).toBe(1);
  });

  test("calls adapter.complete() once per distinct related-story group (D1)", async () => {
    const { adapter, completeCalls } = makeMockAdapter("Fix it.");

    // AC-1 → US-001, AC-2 → US-002 (different stories → 2 groups → 2 LLM calls)
    const options: GenerateFixStoriesOptions = {
      ...makeFixOptions(),
      failedACs: ["AC-1", "AC-2"],
      prd: {
        ...SAMPLE_PRD,
        userStories: [
          {
            ...SAMPLE_PRD.userStories[0],
            id: "US-001",
            acceptanceCriteria: ["AC-1: first"],
          },
          {
            ...SAMPLE_PRD.userStories[0],
            id: "US-002",
            acceptanceCriteria: ["AC-2: second"],
          },
        ],
      },
    };

    await generateFixStories(adapter, options);

    expect(completeCalls.length).toBe(2);
  });
});
