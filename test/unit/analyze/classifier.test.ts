/**
 * Tests for classifier.ts — adapter.complete() refactor (AA-002)
 *
 * Covers:
 * - classifier uses adapter via _classifyDeps instead of Anthropic SDK
 * - adapter.complete() called with jsonMode: true
 * - model resolved from config.models.fast (not hardcoded)
 * - no real API calls — adapter.complete() is mocked via _classifyDeps
 * - fallback to keyword matching when adapter fails
 * - disabled llmEnhanced uses keyword fallback without calling adapter
 */

import { describe, expect, mock, test } from "bun:test";
import { _classifyDeps, classifyStories } from "../../../src/analyze/classifier";
import type { NaxConfig } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import type { CodebaseScan } from "../../../src/analyze/types";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const makeStory = (id: string, title = "A story"): UserStory => ({
  id,
  title,
  description: "Some description",
  acceptanceCriteria: ["AC-1"],
  tags: [],
  dependencies: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
});

const makeScan = (): CodebaseScan => ({
  fileTree: "src/\n  index.ts",
  dependencies: { typescript: "5.0.0" },
  devDependencies: { "@types/bun": "1.0.0" },
  testPatterns: ["bun:test"],
});

const makeConfig = (analyzeOverride?: Partial<NaxConfig["analyze"]>): NaxConfig => ({
  version: 1,
  models: {
    claude: {
      fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
      balanced: { provider: "anthropic", model: "sonnet" },
      powerful: { provider: "anthropic", model: "opus" },
    },
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
    llmEnhanced: true,
    model: "balanced",
    fallbackToKeywords: true,
    maxCodebaseSummaryTokens: 5000,
    ...analyzeOverride,
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
});

/** Builds a valid JSON response string that classifyWithLLM expects */
function makeAdapterResponse(stories: UserStory[]): string {
  const items = stories.map((s) => ({
    storyId: s.id,
    complexity: "medium",
    relevantFiles: ["src/index.ts"],
    reasoning: "Mocked classification",
    estimatedLOC: 100,
    risks: [],
  }));
  return JSON.stringify(items);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for saving/restoring _classifyDeps.adapter.complete
// ─────────────────────────────────────────────────────────────────────────────

let savedComplete: typeof _classifyDeps.adapter.complete;

function saveComplete() {
  savedComplete = _classifyDeps.adapter.complete;
}

function restoreComplete() {
  _classifyDeps.adapter.complete = savedComplete;
}

/** Helper to set/restore ANTHROPIC_API_KEY for LLM path tests */
function withApiKey(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      await fn();
    } finally {
      if (originalKey) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyStories — adapter.complete() integration (AA-002)", () => {
  // ── _classifyDeps existence — these fail first (RED: not exported yet) ───

  test("_classifyDeps is exported from classifier module", () => {
    expect(_classifyDeps).toBeDefined();
  });

  test("_classifyDeps.adapter has a complete() method", () => {
    expect(typeof _classifyDeps.adapter.complete).toBe("function");
  });

  // ── LLM path: adapter.complete() is called with jsonMode: true ───────────

  describe("when llmEnhanced is true", () => {
    test(
      "calls adapter.complete() with jsonMode: true",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        let capturedOptions: Parameters<typeof _classifyDeps.adapter.complete>[1];
        _classifyDeps.adapter.complete = mock(async (_prompt: string, options) => {
          capturedOptions = options;
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        expect(capturedOptions?.jsonMode).toBe(true);
        expect(capturedOptions?.sessionRole).toBe("decompose");
      })
    );

    test(
      "calls adapter.complete() exactly once per classifyStories call",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001"), makeStory("US-002")];
        const scan = makeScan();
        const config = makeConfig();
        let callCount = 0;

        _classifyDeps.adapter.complete = mock(async () => {
          callCount++;
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        expect(callCount).toBe(1);
      })
    );

    test(
      "passes model from config.models.fast to adapter.complete()",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        let capturedOptions: Parameters<typeof _classifyDeps.adapter.complete>[1];
        _classifyDeps.adapter.complete = mock(async (_prompt: string, options) => {
          capturedOptions = options;
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        // config.models.fast.model = "claude-haiku-4-5-20251001"
        expect(capturedOptions?.model).toBe("claude-haiku-4-5-20251001");
      })
    );

    test(
      "model dynamically reflects config.models.fast — not hardcoded",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        // Use a custom fast model to verify dynamic resolution
        const config = makeConfig();
        config.models.claude = {
          ...config.models.claude,
          fast: { provider: "anthropic", model: "claude-haiku-custom-model" },
        };

        let capturedOptions: Parameters<typeof _classifyDeps.adapter.complete>[1];
        _classifyDeps.adapter.complete = mock(async (_prompt: string, options) => {
          capturedOptions = options;
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        expect(capturedOptions?.model).toBe("claude-haiku-custom-model");
      })
    );

    test(
      "model is never the old hardcoded 'claude-haiku-4-20250514'",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        let capturedOptions: Parameters<typeof _classifyDeps.adapter.complete>[1];
        _classifyDeps.adapter.complete = mock(async (_prompt: string, options) => {
          capturedOptions = options;
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        expect(capturedOptions?.model).not.toBe("claude-haiku-4-20250514");
      })
    );

    test(
      "returns llm method when adapter.complete() succeeds",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        _classifyDeps.adapter.complete = mock(async () => makeAdapterResponse(stories));

        const result = await classifyStories(stories, scan, config);
        restoreComplete();

        expect(result.method).toBe("llm");
      })
    );

    test(
      "returns classifications for all stories",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001"), makeStory("US-002"), makeStory("US-003")];
        const scan = makeScan();
        const config = makeConfig();

        _classifyDeps.adapter.complete = mock(async () => makeAdapterResponse(stories));

        const result = await classifyStories(stories, scan, config);
        restoreComplete();

        expect(result.classifications).toHaveLength(3);
        const ids = result.classifications.map((c) => c.storyId);
        expect(ids).toContain("US-001");
        expect(ids).toContain("US-002");
        expect(ids).toContain("US-003");
      })
    );

    test(
      "classifications include contextFiles from adapter response",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        _classifyDeps.adapter.complete = mock(async () =>
          JSON.stringify([
            {
              storyId: "US-001",
              complexity: "simple",
              relevantFiles: ["src/foo.ts", "src/bar.ts"],
              reasoning: "Two files only",
              estimatedLOC: 50,
              risks: [],
            },
          ]),
        );

        const result = await classifyStories(stories, scan, config);
        restoreComplete();

        expect(result.classifications[0].contextFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
      })
    );

    test(
      "prompt passed to adapter.complete() includes story ID and title",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001", "Add caching layer")];
        const scan = makeScan();
        const config = makeConfig();

        let capturedPrompt = "";
        _classifyDeps.adapter.complete = mock(async (prompt: string) => {
          capturedPrompt = prompt;
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        expect(capturedPrompt).toContain("US-001");
        expect(capturedPrompt).toContain("Add caching layer");
      })
    );

    test(
      "prompt passed to adapter.complete() includes codebase file tree",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = { ...makeScan(), fileTree: "src/\n  custom-tree.ts" };
        const config = makeConfig();

        let capturedPrompt = "";
        _classifyDeps.adapter.complete = mock(async (prompt: string) => {
          capturedPrompt = prompt;
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        expect(capturedPrompt).toContain("custom-tree.ts");
      })
    );
  });

  // ── Fallback: adapter.complete() throws → keyword fallback ───────────────

  describe("when adapter.complete() throws", () => {
    test(
      "falls back to keyword-fallback method",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        _classifyDeps.adapter.complete = mock(async () => {
          throw new Error("adapter failure");
        });

        const result = await classifyStories(stories, scan, config);
        restoreComplete();

        expect(result.method).toBe("keyword-fallback");
      })
    );

    test(
      "includes fallbackReason describing the error",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        _classifyDeps.adapter.complete = mock(async () => {
          throw new Error("network timeout");
        });

        const result = await classifyStories(stories, scan, config);
        restoreComplete();

        expect(result.fallbackReason).toContain("network timeout");
      })
    );

    test(
      "still returns classifications for all stories on fallback",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001"), makeStory("US-002")];
        const scan = makeScan();
        const config = makeConfig();

        _classifyDeps.adapter.complete = mock(async () => {
          throw new Error("adapter failure");
        });

        const result = await classifyStories(stories, scan, config);
        restoreComplete();

        expect(result.classifications).toHaveLength(2);
      })
    );
  });

  // ── Disabled LLM path ────────────────────────────────────────────────────

  describe("when llmEnhanced is false", () => {
    test("returns keyword-fallback without calling adapter.complete()", async () => {
      saveComplete();
      const stories = [makeStory("US-001")];
      const scan = makeScan();
      const config = makeConfig({ llmEnhanced: false });
      let adapterCalled = false;

      _classifyDeps.adapter.complete = mock(async () => {
        adapterCalled = true;
        return makeAdapterResponse(stories);
      });

      const result = await classifyStories(stories, scan, config);
      restoreComplete();

      expect(adapterCalled).toBe(false);
      expect(result.method).toBe("keyword-fallback");
    });

    test("fallbackReason explains LLM is disabled", async () => {
      saveComplete();
      const stories = [makeStory("US-001")];
      const scan = makeScan();
      const config = makeConfig({ llmEnhanced: false });

      _classifyDeps.adapter.complete = mock(async () => makeAdapterResponse(stories));

      const result = await classifyStories(stories, scan, config);
      restoreComplete();

      expect(result.fallbackReason).toMatch(/disabled/i);
    });
  });

  // ── No Anthropic SDK — prompt is plain string ────────────────────────────

  describe("API shape — no SDK message objects", () => {
    test(
      "adapter.complete() receives a plain string prompt (not SDK message format)",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        let capturedFirstArg: unknown;
        _classifyDeps.adapter.complete = mock(async (prompt) => {
          capturedFirstArg = prompt;
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        expect(typeof capturedFirstArg).toBe("string");
      })
    );

    test(
      "adapter.complete() second arg is an options object, not an SDK model param",
      withApiKey(async () => {
        saveComplete();
        const stories = [makeStory("US-001")];
        const scan = makeScan();
        const config = makeConfig();

        const callArgs: unknown[][] = [];
        _classifyDeps.adapter.complete = mock(async (...args: unknown[]) => {
          callArgs.push(args);
          return makeAdapterResponse(stories);
        });

        await classifyStories(stories, scan, config);
        restoreComplete();

        expect(callArgs).toHaveLength(1);
        // Second arg: options object or undefined (never a string model name like SDK expects)
        const secondArg = callArgs[0][1];
        if (secondArg !== undefined) {
          expect(typeof secondArg).toBe("object");
          expect(Array.isArray(secondArg)).toBe(false);
        }
      })
    );
  });
});
