/**
 * Tests for ACC-002: PRD-based acceptance test generator
 *
 * File: generator-prd-result.test.ts
 * Covers:
 * - generateFromPRD produces acceptance.test.ts content from UserStory[] and RefinedCriterion[]
 * - generateFromPRD — result shape
 * - generateFromPRD — uses refined criterion text
 * - generateFromPRD — AC-N naming format
 * - generateFromPRD — bun:test import
 * - generateFromPRD — acceptance-refined.json is written
 * - generateFromPRD — adapter.complete() usage
 * - _generatorPRDDeps — exported interface
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { _generatorPRDDeps, generateFromPRD } from "../../../src/acceptance/generator";
import type { GenerateFromPRDOptions, RefinedCriterion } from "../../../src/acceptance/types";
import type { IAgentManager } from "../../../src/agents";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd/types";
import { withDepsRestore } from "../../helpers/deps";
import { makeTempDir } from "../../helpers/temp";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
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
      escalation: {
        enabled: false,
        tierOrder: [{ tier: "fast", attempts: 3 }],
      },
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

function makeUserStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "ACC-002",
    title: "Rewrite acceptance test generator",
    description: "Rewrite generator to use PRD-based input",
    acceptanceCriteria: [
      "generateFromPRD produces acceptance.test.ts content",
      "Generated tests use refined criterion text",
      "Each test is named with AC-N format",
    ],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makeRefinedCriteria(storyId: string): RefinedCriterion[] {
  return [
    {
      original: "generateFromPRD produces acceptance.test.ts content",
      refined: "generateFromPRD returns AcceptanceTestResult with non-empty testCode string",
      testable: true,
      storyId,
    },
    {
      original: "Generated tests use refined criterion text",
      refined: "The testCode contains the refined description string, not the original vague text",
      testable: true,
      storyId,
    },
    {
      original: "Each test is named with AC-N format",
      refined: "Each test block uses the format 'AC-1:', 'AC-2:', etc. matching criterion index",
      testable: true,
      storyId,
    },
  ];
}

function makeOptions(workdir: string, featureDir?: string): GenerateFromPRDOptions {
  return {
    featureName: "acceptance-pipeline",
    workdir,
    featureDir: featureDir ?? workdir,
    codebaseContext: "File tree:\nsrc/\n  acceptance/\n    generator.ts\n",
    modelTier: "fast",
    modelDef: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    config: makeConfig(),
  };
}

function makeGeneratedTestCode(featureName: string, criteria: RefinedCriterion[]): string {
  const tests = criteria
    .map((c, i) => {
      return `  test("AC-${i + 1}: ${c.refined}", async () => {
    expect(true).toBe(true);
  });`;
    })
    .join("\n\n");

  return `import { describe, test, expect } from "bun:test";

describe("${featureName} - Acceptance Tests", () => {
${tests}
});
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for saving/restoring _generatorPRDDeps
// ─────────────────────────────────────────────────────────────────────────────


function makeMockGeneratorManager(
  completeFn?: (prompt: string, opts: any) => Promise<{ output: string; costUsd: number; source: string }>,
): IAgentManager {
  return {
    getAgent: (_name: string) => ({ complete: async () => ({ output: '', costUsd: 0, source: 'fallback' }) } as any),
    getDefault: () => 'claude',
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
    events: { on: () => {} } as any,
    resolveFallbackChain: () => [],
    shouldSwap: () => false,
    nextCandidate: () => null,
    runWithFallback: async () => ({ result: { success: true, exitCode: 0, output: '', rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }, fallbacks: [] }),
    completeWithFallback: completeFn
      ? async (prompt: string, opts: any) => ({ result: await completeFn(prompt, opts), fallbacks: [] })
      : async () => ({ result: { output: '', costUsd: 0, source: 'fallback' }, fallbacks: [] }),
    run: async () => ({ success: true, exitCode: 0, output: '', rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    complete: completeFn
      ? async (prompt: string, opts: any) => completeFn(prompt, opts)
      : async () => ({ output: '', costUsd: 0, source: 'fallback' }),
    completeAs: completeFn
      ? async (name: string, opts: any) => completeFn('', opts)
      : async () => ({ output: '', costUsd: 0, source: 'fallback' }),
    runAs: async () => ({ success: true, exitCode: 0, output: '', rateLimited: false, durationMs: 0, estimatedCost: 0, agentFallbacks: [] }),
    plan: async () => ({ specContent: '' }),
    planAs: async () => ({ specContent: '' }),
    decompose: async () => ({ stories: [] }),
    decomposeAs: async () => ({ stories: [] }),
  } as any;
}

withDepsRestore(_generatorPRDDeps, ["agentManager", "writeFile", "backupFile"]);

// ─────────────────────────────────────────────────────────────────────────────
// generateFromPRD — result shape
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — result shape", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  test("returns AcceptanceTestResult with testCode string", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result).toBeDefined();
    expect(typeof result.testCode).toBe("string");
    expect(result.testCode.length).toBeGreaterThan(0);
  });

  test("returns AcceptanceTestResult with criteria array", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(Array.isArray(result.criteria)).toBe(true);
  });

  test("returns empty testCode when no criteria provided", async () => {
    const story = makeUserStory({ acceptanceCriteria: [] });
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: "", costUsd: 0, source: "mock" as const }))
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], [], options);

    expect(result).toBeDefined();
    expect(typeof result.testCode).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateFromPRD — uses refined criterion text
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — uses refined criterion text", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  test("prompt sent to adapter.complete() contains refined text", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let capturedPrompt = "";

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async (prompt: string) => { capturedPrompt = prompt; return { output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: 'mock' as const }; });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    for (const c of criteria) {
      expect(capturedPrompt).toContain(c.refined);
    }
  });

  test("prompt sent to adapter.complete() does NOT contain only original vague text when refined differs", async () => {
    const story = makeUserStory();
    const criteria: RefinedCriterion[] = [
      {
        original: "vague original text that should not appear alone",
        refined: "Concrete refined assertion: function returns array of length 3",
        testable: true,
        storyId: story.id,
      },
    ];
    const options = makeOptions(tmpDir);
    let capturedPrompt = "";

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async (prompt: string) => { capturedPrompt = prompt; return { output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: 'mock' as const }; });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain("Concrete refined assertion: function returns array of length 3");
  });

  test("prompt sent to adapter.complete() contains 3-step structure", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let capturedPrompt = "";

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async (prompt: string) => { capturedPrompt = prompt; return { output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: 'mock' as const }; });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain("Step 1");
    expect(capturedPrompt).toContain("Step 2");
    expect(capturedPrompt).toContain("Step 3");
    expect(capturedPrompt).toContain("NEVER use placeholder assertions");
  });

  test("prompt sent to adapter.complete() contains feature name", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let capturedPrompt = "";

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async (prompt: string) => { capturedPrompt = prompt; return { output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: 'mock' as const }; });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain(options.featureName);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateFromPRD — AC-N naming format
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — AC-N naming format in generated tests", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  test("generated testCode contains AC-1 test name for first criterion", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("AC-1:");
  });

  test("generated testCode contains AC-N for each criterion index", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    for (let i = 1; i <= criteria.length; i++) {
      expect(result.testCode).toContain(`AC-${i}:`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateFromPRD — bun:test import
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — bun:test import in generated file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  test("generated testCode contains bun:test import", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain('from "bun:test"');
  });

  test("generated testCode contains describe and test keywords", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("describe");
    expect(result.testCode).toContain("test(");
    expect(result.testCode).toContain("expect");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateFromPRD — writes acceptance-refined.json
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — writes acceptance-refined.json", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  test("calls writeFile for acceptance-refined.json", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    const writtenPaths: string[] = [];

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async (path: string) => {
      writtenPaths.push(path);
    });

    await generateFromPRD([story], criteria, options);

    const refinedJsonWritten = writtenPaths.some((p) => p.endsWith("acceptance-refined.json"));
    expect(refinedJsonWritten).toBe(true);
  });

  test("acceptance-refined.json content is valid JSON with original-to-refined mapping", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let refinedJsonContent = "";

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async (path: string, content: string) => {
      if (path.endsWith("acceptance-refined.json")) {
        refinedJsonContent = content;
      }
    });

    await generateFromPRD([story], criteria, options);

    expect(refinedJsonContent.length).toBeGreaterThan(0);
    const parsed = JSON.parse(refinedJsonContent);
    expect(parsed).toBeDefined();
  });

  test("acceptance-refined.json contains original and refined fields for each criterion", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let refinedJsonContent = "";

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async (path: string, content: string) => {
      if (path.endsWith("acceptance-refined.json")) {
        refinedJsonContent = content;
      }
    });

    await generateFromPRD([story], criteria, options);

    const parsed = JSON.parse(refinedJsonContent);
    const entries = Array.isArray(parsed) ? parsed : Object.values(parsed);
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(entry).toHaveProperty("original");
      expect(entry).toHaveProperty("refined");
    }
  });

  test("calls adapter.complete() not Bun.spawn directly", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    const spawnCalls: unknown[] = [];
    const originalSpawn = Bun.spawn;

    (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
      spawnCalls.push(args);
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    };

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    (Bun as { spawn: unknown }).spawn = originalSpawn;

    expect(spawnCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateFromPRD — adapter.complete() usage
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — adapter.complete() usage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  test("calls adapter.complete() exactly once per call", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let callCount = 0;

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => {
        callCount++;
        return { output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const };
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(callCount).toBe(1);
  });

  test("does not call adapter.complete() when criteria list is empty", async () => {
    const story = makeUserStory({ acceptanceCriteria: [] });
    const options = makeOptions(tmpDir);
    let callCount = 0;

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => {
        callCount++;
        return { output: "", costUsd: 0, source: "mock" as const };
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], [], options);

    expect(callCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _generatorPRDDeps — exported interface
// ─────────────────────────────────────────────────────────────────────────────

describe("_generatorPRDDeps", () => {
  test("is exported from generator module", () => {
    expect(_generatorPRDDeps).toBeDefined();
  });

  test("has agentManager field (defaults to undefined)", () => {
    expect(_generatorPRDDeps).toHaveProperty("agentManager");
  });

  test("has writeFile function", () => {
    expect(typeof _generatorPRDDeps.writeFile).toBe("function");
  });

  test("has backupFile function", () => {
    expect(typeof _generatorPRDDeps.backupFile).toBe("function");
  });
});
