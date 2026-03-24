/**
 * Tests for src/acceptance/refinement.ts — AC refinement module (ACC-001)
 *
 * Covers:
 * - refineAcceptanceCriteria returns RefinedCriterion[] with original and refined fields
 * - buildRefinementPrompt includes all criteria and codebase context
 * - parseRefinementResponse handles valid JSON response correctly
 * - parseRefinementResponse falls back to original text on malformed JSON
 * - Criteria marked testable:false are preserved but flagged
 * - Module uses adapter.complete() for LLM calls, not direct Bun.spawn
 */

import { describe, expect, mock, test } from "bun:test";
import { withDepsRestore } from "../../helpers/deps";
import {
  _refineDeps,
  buildRefinementPrompt,
  parseRefinementResponse,
  refineAcceptanceCriteria,
} from "../../../src/acceptance/refinement";
import type { NaxConfig } from "../../../src/config";
import type { RefinedCriterion } from "../../../src/acceptance/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const STORY_ID = "ACC-001";

const SAMPLE_CRITERIA = [
  "refineAcceptanceCriteria returns RefinedCriterion[] with original and refined fields",
  "buildRefinementPrompt includes all criteria and codebase context in output",
  "parseRefinementResponse handles valid JSON response correctly",
];

const CODEBASE_CONTEXT = "File tree:\nsrc/\n  acceptance/\n    refinement.ts\n";

function makeConfig(acceptanceOverride?: Partial<NaxConfig["acceptance"]>): NaxConfig {
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
      ...acceptanceOverride,
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

/** Build a valid LLM JSON response for the given criteria */
function makeLLMResponse(criteria: string[], storyId: string, testable = true): string {
  const items: RefinedCriterion[] = criteria.map((c) => ({
    original: c,
    refined: `Verify that: ${c}`,
    testable,
    storyId,
  }));
  return JSON.stringify(items);
}

// ─────────────────────────────────────────────────────────────────────────────
withDepsRestore(_refineDeps, ["adapter"]);

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("_refineDeps", () => {
  test("is exported from refinement module", () => {
    expect(_refineDeps).toBeDefined();
  });

  test("has adapter with a complete() method", () => {
    expect(typeof _refineDeps.adapter.complete).toBe("function");
  });
});

describe("buildRefinementPrompt", () => {
  test("includes all criteria strings in the output", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    for (const criterion of SAMPLE_CRITERIA) {
      expect(prompt).toContain(criterion);
    }
  });

  test("includes codebase context in the output", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    expect(prompt).toContain(CODEBASE_CONTEXT);
  });

  test("returns a non-empty string", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("works with empty criteria list", () => {
    const prompt = buildRefinementPrompt([], CODEBASE_CONTEXT);

    expect(typeof prompt).toBe("string");
  });

  test("works with empty codebase context", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "");

    for (const criterion of SAMPLE_CRITERIA) {
      expect(prompt).toContain(criterion);
    }
  });
});

describe("parseRefinementResponse", () => {
  test("parses valid JSON response into RefinedCriterion[]", () => {
    const response = makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    const result = parseRefinementResponse(response, SAMPLE_CRITERIA);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
  });

  test("each result has original field matching input criteria", () => {
    const response = makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    const result = parseRefinementResponse(response, SAMPLE_CRITERIA);

    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("each result has a non-empty refined field", () => {
    const response = makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    const result = parseRefinementResponse(response, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(typeof item.refined).toBe("string");
      expect(item.refined.length).toBeGreaterThan(0);
    }
  });

  test("each result has a boolean testable field", () => {
    const response = makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    const result = parseRefinementResponse(response, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(typeof item.testable).toBe("boolean");
    }
  });

  test("each result has a storyId field", () => {
    const response = makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    const result = parseRefinementResponse(response, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(typeof item.storyId).toBe("string");
      expect(item.storyId.length).toBeGreaterThan(0);
    }
  });

  test("falls back to original text on malformed JSON", () => {
    const result = parseRefinementResponse("this is not valid JSON {{{", SAMPLE_CRITERIA);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
      expect(result[i].refined).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("falls back to original text on empty response", () => {
    const result = parseRefinementResponse("", SAMPLE_CRITERIA);

    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("preserves testable:false items from valid JSON response", () => {
    const response = makeLLMResponse(SAMPLE_CRITERIA, STORY_ID, false);
    const result = parseRefinementResponse(response, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(item.testable).toBe(false);
    }
  });

  test("fallback items have testable:true by default", () => {
    const result = parseRefinementResponse("invalid json", SAMPLE_CRITERIA);

    for (const item of result) {
      expect(item.testable).toBe(true);
    }
  });
});

describe("refineAcceptanceCriteria — adapter.complete() integration", () => {
  test("calls adapter.complete() exactly once per call", async () => {
    const config = makeConfig();
    let callCount = 0;

    _refineDeps.adapter.complete = mock(async () => {
      callCount++;
      return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(callCount).toBe(1);
  });

  test("does NOT call Bun.spawn directly — uses adapter.complete()", async () => {
    const config = makeConfig();
    const spawnCalls: unknown[] = [];
    const originalSpawn = Bun.spawn;

    // Temporarily monitor Bun.spawn to detect direct usage
    (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
      spawnCalls.push(args);
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    };

    _refineDeps.adapter.complete = mock(async () =>
      makeLLMResponse(SAMPLE_CRITERIA, STORY_ID),
    );

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    (Bun as { spawn: unknown }).spawn = originalSpawn;

    expect(spawnCalls).toHaveLength(0);
  });

  test("returns RefinedCriterion[] with original field matching input", async () => {
    const config = makeConfig();

    _refineDeps.adapter.complete = mock(async () =>
      makeLLMResponse(SAMPLE_CRITERIA, STORY_ID),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("returns RefinedCriterion[] with refined field from LLM response", async () => {
    const config = makeConfig();

    _refineDeps.adapter.complete = mock(async () =>
      makeLLMResponse(SAMPLE_CRITERIA, STORY_ID),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    for (const item of result) {
      expect(typeof item.refined).toBe("string");
      expect(item.refined.length).toBeGreaterThan(0);
    }
  });

  test("passes a plain string prompt to adapter.complete() (not SDK format)", async () => {
    const config = makeConfig();
    let capturedPrompt: unknown;

    _refineDeps.adapter.complete = mock(async (prompt) => {
      capturedPrompt = prompt;
      return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(typeof capturedPrompt).toBe("string");
  });

  test("prompt passed to adapter.complete() contains all criteria", async () => {
    const config = makeConfig();
    let capturedPrompt = "";

    _refineDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    for (const criterion of SAMPLE_CRITERIA) {
      expect(capturedPrompt).toContain(criterion);
    }
  });

  test("prompt passed to adapter.complete() contains codebase context", async () => {
    const config = makeConfig();
    let capturedPrompt = "";

    _refineDeps.adapter.complete = mock(async (prompt: string) => {
      capturedPrompt = prompt;
      return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(capturedPrompt).toContain(CODEBASE_CONTEXT);
  });

  test("preserves criteria with testable:false in the result", async () => {
    const config = makeConfig();

    _refineDeps.adapter.complete = mock(async () =>
      makeLLMResponse(SAMPLE_CRITERIA, STORY_ID, false),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (const item of result) {
      expect(item.testable).toBe(false);
    }
  });

  test("assigns storyId from context to all RefinedCriterion items", async () => {
    const config = makeConfig();
    const customStoryId = "STORY-XYZ";

    _refineDeps.adapter.complete = mock(async () =>
      makeLLMResponse(SAMPLE_CRITERIA, customStoryId),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: customStoryId,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    for (const item of result) {
      expect(item.storyId).toBe(customStoryId);
    }
  });

  test("handles empty criteria list without calling adapter.complete()", async () => {
    const config = makeConfig();
    let adapterCalled = false;

    _refineDeps.adapter.complete = mock(async () => {
      adapterCalled = true;
      return "[]";
    });

    const result = await refineAcceptanceCriteria([], {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(result).toHaveLength(0);
    expect(adapterCalled).toBe(false);
  });

  test("falls back to original text when adapter.complete() returns malformed JSON", async () => {
    const config = makeConfig();

    _refineDeps.adapter.complete = mock(async () => "not valid json at all {{{");

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
      expect(result[i].refined).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("falls back gracefully when adapter.complete() throws", async () => {
    const config = makeConfig();

    _refineDeps.adapter.complete = mock(async () => {
      throw new Error("adapter network error");
    });

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    // Should return fallback results, not throw
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });
});
