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
import { DEFAULT_CONFIG } from "../../../src/config";
import type { NaxConfig } from "../../../src/config";
import type { RefinedCriterion } from "../../../src/acceptance/types";
import type { CompleteResult } from "../../../src/agents/types";

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
    ...DEFAULT_CONFIG,
    models: {
      claude: {
        fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        balanced: { provider: "anthropic", model: "claude-sonnet-4-5" },
        powerful: { provider: "anthropic", model: "claude-opus-4-5" },
      },
    },
    autoMode: { ...DEFAULT_CONFIG.autoMode, defaultAgent: "claude" },
    acceptance: { ...DEFAULT_CONFIG.acceptance, model: "fast", ...acceptanceOverride },
  };
}

/** Build a valid LLM JSON response for the given criteria, wrapped as CompleteResult */
function makeLLMResponse(criteria: string[], storyId: string, testable = true): CompleteResult {
  const items: RefinedCriterion[] = criteria.map((c) => ({
    original: c,
    refined: `Verify that: ${c}`,
    testable,
    storyId,
  }));
  return { output: JSON.stringify(items), costUsd: 0, source: "fallback" };
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

  test("omits CODEBASE CONTEXT section when codebaseContext is empty", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "");
    expect(prompt).not.toContain("CODEBASE CONTEXT:");
  });

  test("includes CODEBASE CONTEXT section when codebaseContext is provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);
    expect(prompt).toContain("CODEBASE CONTEXT:");
    expect(prompt).toContain(CODEBASE_CONTEXT);
  });

  test("includes STORY CONTEXT section when storyTitle is provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", { storyTitle: "Export tasks to CSV" });
    expect(prompt).toContain("STORY CONTEXT:");
    expect(prompt).toContain("Export tasks to CSV");
  });

  test("includes storyDescription in STORY CONTEXT when provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "", {
      storyTitle: "Export tasks to CSV",
      storyDescription: "As a user, I can call exportTasks() to get a file",
    });
    expect(prompt).toContain("As a user, I can call exportTasks() to get a file");
  });

  test("omits STORY CONTEXT section when neither storyTitle nor storyDescription is provided", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, "");
    expect(prompt).not.toContain("STORY CONTEXT:");
  });

  test("STORY CONTEXT appears before CODEBASE CONTEXT in the prompt", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      storyTitle: "Export tasks to CSV",
    });
    const storyIdx = prompt.indexOf("STORY CONTEXT:");
    const codebaseIdx = prompt.indexOf("CODEBASE CONTEXT:");
    expect(storyIdx).toBeGreaterThanOrEqual(0);
    expect(codebaseIdx).toBeGreaterThan(storyIdx);
  });
});

describe("parseRefinementResponse", () => {
  test("parses valid JSON response into RefinedCriterion[]", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(SAMPLE_CRITERIA.length);
  });

  test("each result has original field matching input criteria", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("each result has a non-empty refined field", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(typeof item.refined).toBe("string");
      expect(item.refined.length).toBeGreaterThan(0);
    }
  });

  test("each result has a boolean testable field", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

    for (const item of result) {
      expect(typeof item.testable).toBe("boolean");
    }
  });

  test("each result has a storyId field", () => {
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID).output, SAMPLE_CRITERIA);

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
    const result = parseRefinementResponse(makeLLMResponse(SAMPLE_CRITERIA, STORY_ID, false).output, SAMPLE_CRITERIA);

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

  test("uses config.acceptance.model tier to resolve adapter model", async () => {
    const config = makeConfig({ model: "balanced" });
    let receivedModel: string | undefined;

    _refineDeps.adapter.complete = mock(async (_prompt, options) => {
      receivedModel = options?.model;
      return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(receivedModel).toBe("claude-sonnet-4-5");
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
      return { output: "[]", costUsd: 0, source: "fallback" } satisfies CompleteResult;
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

    _refineDeps.adapter.complete = mock(async () => ({ output: "not valid json at all {{{", costUsd: 0, source: "fallback" } satisfies CompleteResult));

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
