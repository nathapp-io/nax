/**
 * Tests for ACC-002: PRD-based acceptance test generator
 *
 * File: generator-prd-fallback.test.ts
 * Covers:
 * - generateFromPRD — non-code output fallback (ENH-003)
 * - generateFromPRD — acceptance-refined.json is written to featureDir not workdir (BUG-075)
 * - backward compatibility — generateAcceptanceTests still works for spec.md path
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _generatorPRDDeps, generateAcceptanceTests, generateFromPRD } from "../../../src/acceptance/generator";
import type { GenerateFromPRDOptions, RefinedCriterion } from "../../../src/acceptance/types";
import type { IAgentManager } from "../../../src/agents";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd/types";
import { withDepsRestore } from "../../helpers/deps";
import { makeTempDir } from "../../helpers/temp";
import { makeMockAgentManager } from "../../helpers";

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
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    completeFn: completeFn
      ? async (_agentName: string, prompt: string, opts: any) => completeFn(prompt, opts)
      : async () => ({ output: "", costUsd: 0, source: "fallback" as const }),
    runFn: async () => ({
      success: true,
      exitCode: 0,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCostUsd: 0,
      agentFallbacks: [] as unknown[],
    }),
  });
}

withDepsRestore(_generatorPRDDeps, ["agentManager", "writeFile", "backupFile"]);

// ─────────────────────────────────────────────────────────────────────────────
// BUG-075: acceptance-refined.json written to featureDir not workdir
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — acceptance-refined.json is written to featureDir not workdir", () => {
  let workdir: string;
  let featureDir: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-test-workdir-");
    featureDir = makeTempDir("nax-test-featuredir-");
  });

  test("acceptance-refined.json is written to featureDir, not workdir", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(workdir, featureDir);
    const writtenPaths: string[] = [];

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: makeGeneratedTestCode(options.featureName, criteria), costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async (path: string) => {
      writtenPaths.push(path);
    });

    await generateFromPRD([story], criteria, options);

    const refinedJsonPath = writtenPaths.find((p) => p.endsWith("acceptance-refined.json"));
    expect(refinedJsonPath).toBeDefined();
    expect(refinedJsonPath).toContain(featureDir);
    expect(refinedJsonPath).not.toContain(workdir);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateFromPRD — non-code LLM output falls back to skeleton (ENH-003)
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — non-code LLM output falls back to skeleton", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("nax-test-");
  });

  test("LLM prose output (no code) returns skeleton tests", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: "File written to `nax/features/refactor-standard/acceptance.test.ts`. Here's a summary of the 43 tests and their verification strategy:\n\n**US-001 — Planning (AC-1 to AC-5):** Validates the PRD JSON exists.", costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("describe(");
    expect(result.testCode).toContain("expect(true).toBe(false)");
    expect(result.testCode).toContain("AC-1:");
  });

  test("LLM returns markdown summary without code fences returns skeleton", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: "Here are the acceptance tests I would generate:\n\n1. Test that the system handles empty input\n2. Test that tokens expire correctly", costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("describe(");
    expect(result.testCode).toContain("TODO");
  });

  test("LLM returns valid code inside markdown fences — extracts correctly", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    const codeInFences =
      '```typescript\nimport { describe, test, expect } from "bun:test";\n\ndescribe("test", () => {\n  test("AC-1: works", () => {\n    expect(1).toBe(1);\n  });\n});\n```';
    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: codeInFences, costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("import { describe, test, expect }");
    expect(result.testCode).not.toContain("```");
    expect(result.testCode).not.toContain("TODO");
  });

  test("LLM returns code without fences but with import — extracts correctly", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    const rawCode =
      'import { describe, test, expect } from "bun:test";\n\ndescribe("test", () => {\n  test("AC-1: works", () => {\n    expect(1).toBe(1);\n  });\n});';
    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: rawCode, costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("import { describe, test, expect }");
    expect(result.testCode).not.toContain("TODO");
  });

  test("BUG-076: preserves agent-written test file and writes recovery backup when extractor misses", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    const targetPath = join(tmpDir, ".nax", "features", options.featureName, options.config.acceptance.testPath);
    const backupPath = `${targetPath}.llm-recovery.bak`;

    const llmWrittenTest = `/**
 * Acceptance tests generated by LLM
 */
import type { UserStory } from "../../../src/prd/types";

test("AC-1: preserves file", () => {
  expect(true).toBe(true);
});
`;

    mkdirSync(join(tmpDir, ".nax", "features", options.featureName), { recursive: true });
    await Bun.write(targetPath, llmWrittenTest);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: "I wrote the file directly to disk.", costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});
    _generatorPRDDeps.backupFile = mock(async (path: string, content: string) => {
      await Bun.write(path, content);
    });

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain('test("AC-1: preserves file"');
    expect(existsSync(backupPath)).toBe(true);
    expect(await Bun.file(backupPath).text()).toContain('test("AC-1: preserves file"');
  });

  test("BUG-076: preserves agent-written test file even when backup write fails", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    const targetPath = join(tmpDir, ".nax", "features", options.featureName, options.config.acceptance.testPath);

    const llmWrittenTest = `import type { UserStory } from "../../../src/prd/types";

test("AC-1: keep even if backup fails", () => {
  expect(true).toBe(true);
});
`;

    mkdirSync(join(tmpDir, ".nax", "features", options.featureName), { recursive: true });
    await Bun.write(targetPath, llmWrittenTest);

    _generatorPRDDeps.agentManager = makeMockGeneratorManager(async () => ({ output: "I wrote the file directly to disk.", costUsd: 0, source: "mock" as const }));
    _generatorPRDDeps.writeFile = mock(async () => {});
    _generatorPRDDeps.backupFile = mock(async () => {
      throw new Error("disk full");
    });

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain('test("AC-1: keep even if backup fails"');
    expect(result.testCode).not.toContain("TODO");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backward compatibility — generateAcceptanceTests still works
// ─────────────────────────────────────────────────────────────────────────────

describe("backward compatibility — generateAcceptanceTests", () => {
  test("is exported and callable", () => {
    expect(typeof generateAcceptanceTests).toBe("function");
  });

  test("returns AcceptanceTestResult shape when called with valid spec content", async () => {
    const specContent = `# Feature

## Acceptance Criteria
- AC-1: System should handle empty input
- AC-2: System should return 200 on success
`;

const mockAdapter = makeMockAgentManager({
      getDefaultAgent: "claude",
      completeFn: async () => ({
        output: `import { describe, test, expect } from "bun:test";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: System should handle empty input", async () => {
    expect(true).toBe(true);
  });
  test("AC-2: System should return 200 on success", async () => {
    expect(true).toBe(true);
  });
});
`,
        costUsd: 0,
        source: "mock" as const,
      }),
      runFn: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: 0,
        agentFallbacks: [] as unknown[],
      }),
    });

    const result = await generateAcceptanceTests(mockAdapter, {
      specContent,
      featureName: "test-feature",
      workdir: tmpdir(),
      codebaseContext: "File tree:\nsrc/\n",
      modelTier: "fast",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      config: makeConfig(),
    });

    expect(result).toBeDefined();
    expect(typeof result.testCode).toBe("string");
    expect(Array.isArray(result.criteria)).toBe(true);
  });

  test("criteria from spec.md path use AC-N format IDs", async () => {
    const specContent = `## Acceptance Criteria
- AC-1: First criterion
- AC-2: Second criterion
- AC-3: Third criterion
`;

    const mockAdapter2 = makeMockAgentManager({
      getDefaultAgent: "claude",
      completeFn: async () => ({
        output: `import { describe, test, expect } from "bun:test"; describe("f", () => {});`,
        costUsd: 0,
        source: "mock" as const,
      }),
      runFn: async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCostUsd: 0,
        agentFallbacks: [] as unknown[],
      }),
    });

    const result = await generateAcceptanceTests(mockAdapter2, {
      specContent,
      featureName: "test-feature",
      workdir: tmpdir(),
      codebaseContext: "",
      modelTier: "fast",
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      config: makeConfig(),
    });

    expect(result.criteria).toHaveLength(3);
    expect(result.criteria[0].id).toBe("AC-1");
    expect(result.criteria[1].id).toBe("AC-2");
    expect(result.criteria[2].id).toBe("AC-3");
  });
});
