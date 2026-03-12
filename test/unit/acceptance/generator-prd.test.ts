/**
 * Tests for ACC-002: PRD-based acceptance test generator
 *
 * Covers:
 * - generateFromPRD produces acceptance.test.ts content from UserStory[] and RefinedCriterion[]
 * - Generated tests use refined criterion text, not original vague text
 * - Each test is named with AC-N format matching the story and criterion index
 * - Generated test file imports from bun:test (describe/test/expect)
 * - Backward compatible: existing generateAcceptanceTests still works for spec.md path
 * - acceptance-refined.json is written with original-to-refined mapping
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _generatorPRDDeps, generateAcceptanceTests, generateFromPRD } from "../../../src/acceptance/generator";
import type { GenerateFromPRDOptions, RefinedCriterion } from "../../../src/acceptance/types";
import type { AgentAdapter } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd/types";

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
      environmentalEscalationDivisor: 2,
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

function makeOptions(workdir: string): GenerateFromPRDOptions {
  return {
    featureName: "acceptance-pipeline",
    workdir,
    codebaseContext: "File tree:\nsrc/\n  acceptance/\n    generator.ts\n",
    modelTier: "fast",
    modelDef: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    config: makeConfig(),
  };
}

/** Minimal generated test file that satisfies all ACs */
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

let savedComplete: typeof _generatorPRDDeps.adapter.complete;
let savedWriteFile: typeof _generatorPRDDeps.writeFile;

function saveDeps() {
  savedComplete = _generatorPRDDeps.adapter.complete;
  savedWriteFile = _generatorPRDDeps.writeFile;
}

function restoreDeps() {
  _generatorPRDDeps.adapter.complete = savedComplete;
  _generatorPRDDeps.writeFile = savedWriteFile;
}

// ─────────────────────────────────────────────────────────────────────────────
// describe: generateFromPRD — result shape
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — result shape", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("returns AcceptanceTestResult with testCode string", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
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

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(Array.isArray(result.criteria)).toBe(true);
  });

  test("returns empty testCode when no criteria provided", async () => {
    const story = makeUserStory({ acceptanceCriteria: [] });
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.adapter.complete = mock(async () => "");
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], [], options);

    expect(result).toBeDefined();
    expect(typeof result.testCode).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe: generateFromPRD — uses refined criterion text
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — uses refined criterion text", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("prompt sent to adapter.complete() contains refined text", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let capturedPrompt = "";

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return makeGeneratedTestCode(options.featureName, criteria);
    });
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

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return makeGeneratedTestCode(options.featureName, criteria);
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    // Refined text must appear in the prompt
    expect(capturedPrompt).toContain("Concrete refined assertion: function returns array of length 3");
  });

  test("prompt sent to adapter.complete() contains codebase context", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let capturedPrompt = "";

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return makeGeneratedTestCode(options.featureName, criteria);
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain(options.codebaseContext);
  });

  test("prompt sent to adapter.complete() contains feature name", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let capturedPrompt = "";

    _generatorPRDDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return makeGeneratedTestCode(options.featureName, criteria);
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(capturedPrompt).toContain(options.featureName);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe: generateFromPRD — AC-N naming format
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — AC-N naming format in generated tests", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("generated testCode contains AC-1 test name for first criterion", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("AC-1:");
  });

  test("generated testCode contains AC-N for each criterion index", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    for (let i = 1; i <= criteria.length; i++) {
      expect(result.testCode).toContain(`AC-${i}:`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe: generateFromPRD — bun:test import
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — bun:test import in generated file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("generated testCode contains bun:test import", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain('from "bun:test"');
  });

  test("generated testCode contains describe and test keywords", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
    _generatorPRDDeps.writeFile = mock(async () => {});

    const result = await generateFromPRD([story], criteria, options);

    expect(result.testCode).toContain("describe");
    expect(result.testCode).toContain("test(");
    expect(result.testCode).toContain("expect");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe: generateFromPRD — acceptance-refined.json is written
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — writes acceptance-refined.json", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("calls writeFile for acceptance-refined.json", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    const writtenPaths: string[] = [];

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
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

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
    _generatorPRDDeps.writeFile = mock(async (path: string, content: string) => {
      if (path.endsWith("acceptance-refined.json")) {
        refinedJsonContent = content;
      }
    });

    await generateFromPRD([story], criteria, options);

    expect(refinedJsonContent.length).toBeGreaterThan(0);
    // Must be valid JSON
    const parsed = JSON.parse(refinedJsonContent);
    expect(parsed).toBeDefined();
  });

  test("acceptance-refined.json contains original and refined fields for each criterion", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let refinedJsonContent = "";

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
    _generatorPRDDeps.writeFile = mock(async (path: string, content: string) => {
      if (path.endsWith("acceptance-refined.json")) {
        refinedJsonContent = content;
      }
    });

    await generateFromPRD([story], criteria, options);

    const parsed = JSON.parse(refinedJsonContent);
    // Should be an array or object containing original/refined data
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

    _generatorPRDDeps.adapter.complete = mock(async () => makeGeneratedTestCode(options.featureName, criteria));
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    (Bun as { spawn: unknown }).spawn = originalSpawn;

    expect(spawnCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe: generateFromPRD — adapter called once
// ─────────────────────────────────────────────────────────────────────────────

describe("generateFromPRD — adapter.complete() usage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nax-test-"));
    saveDeps();
  });

  afterEach(() => {
    restoreDeps();
  });

  test("calls adapter.complete() exactly once per call", async () => {
    const story = makeUserStory();
    const criteria = makeRefinedCriteria(story.id);
    const options = makeOptions(tmpDir);
    let callCount = 0;

    _generatorPRDDeps.adapter.complete = mock(async () => {
      callCount++;
      return makeGeneratedTestCode(options.featureName, criteria);
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], criteria, options);

    expect(callCount).toBe(1);
  });

  test("does not call adapter.complete() when criteria list is empty", async () => {
    const story = makeUserStory({ acceptanceCriteria: [] });
    const options = makeOptions(tmpDir);
    let callCount = 0;

    _generatorPRDDeps.adapter.complete = mock(async () => {
      callCount++;
      return "";
    });
    _generatorPRDDeps.writeFile = mock(async () => {});

    await generateFromPRD([story], [], options);

    expect(callCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// describe: backward compatibility — generateAcceptanceTests still works
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

    // Use a mock adapter that avoids real spawning
    const mockAdapter: Partial<AgentAdapter> = {
      binary: "echo",
      name: "mock",
      run: mock(async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      })),
      complete: mock(
        async () => `import { describe, test, expect } from "bun:test";

describe("test-feature - Acceptance Tests", () => {
  test("AC-1: System should handle empty input", async () => {
    expect(true).toBe(true);
  });
  test("AC-2: System should return 200 on success", async () => {
    expect(true).toBe(true);
  });
});
`,
      ),
    };

    const result = await generateAcceptanceTests(mockAdapter as AgentAdapter, {
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

    const mockAdapter: Partial<AgentAdapter> = {
      binary: "echo",
      name: "mock",
      run: mock(async () => ({
        success: true,
        exitCode: 0,
        output: "",
        rateLimited: false,
        durationMs: 0,
        estimatedCost: 0,
      })),
      complete: mock(async () => `import { describe, test, expect } from "bun:test"; describe("f", () => {});`),
    };

    const result = await generateAcceptanceTests(mockAdapter as AgentAdapter, {
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

// ─────────────────────────────────────────────────────────────────────────────
// describe: _generatorPRDDeps — exported interface
// ─────────────────────────────────────────────────────────────────────────────

describe("_generatorPRDDeps", () => {
  test("is exported from generator module", () => {
    expect(_generatorPRDDeps).toBeDefined();
  });

  test("has adapter with a complete() method", () => {
    expect(typeof _generatorPRDDeps.adapter.complete).toBe("function");
  });

  test("has writeFile function", () => {
    expect(typeof _generatorPRDDeps.writeFile).toBe("function");
  });
});
