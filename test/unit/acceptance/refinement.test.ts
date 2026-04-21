/**
 * Tests for src/acceptance/refinement.ts — AC refinement module (ACC-001)
 *
 * Covers:
 * - refineAcceptanceCriteria returns RefinedCriterion[] with original and refined fields
 * - buildRefinementPrompt includes all criteria and codebase context
 * - parseRefinementResponse handles valid JSON response correctly
 * - parseRefinementResponse falls back to original text on malformed JSON
 * - Criteria marked testable:false are preserved but flagged
 * - Module uses createManager + agentManager.complete() for LLM calls, not direct Bun.spawn
 */

import { describe, expect, mock, test } from "bun:test";
import { withDepsRestore } from "../../helpers/deps";
import {
  _refineDeps,
  parseRefinementResponse,
  refineAcceptanceCriteria,
} from "../../../src/acceptance/refinement";
import { AcceptancePromptBuilder } from "../../../src/prompts";

const buildRefinementPrompt = (
  criteria: string[],
  ctx: string,
  opts?: Parameters<AcceptancePromptBuilder["buildRefinementPrompt"]>[2],
) => new AcceptancePromptBuilder().buildRefinementPrompt(criteria, ctx, opts);
import { DEFAULT_CONFIG } from "../../../src/config";
import type { RefinedCriterion } from "../../../src/acceptance/types";
import type { CompleteResult } from "../../../src/agents/types";
import { makeMockAgentManager, makeNaxConfig } from "../../helpers";

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
withDepsRestore(_refineDeps, ["createManager"]);

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("_refineDeps", () => {
  test("is exported from refinement module", () => {
    expect(_refineDeps).toBeDefined();
  });

  test("has createManager function", () => {
    expect(typeof _refineDeps.createManager).toBe("function");
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

describe("refineAcceptanceCriteria — createManager integration", () => {
  test("calls agentManager.complete() exactly once per call", async () => {
    const config = makeNaxConfig();
    let callCount = 0;

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string) => {
          callCount++;
          return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
        },
      }),
    );

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(callCount).toBe(1);
  });

  test("uses config.acceptance.model tier to resolve adapter model", async () => {
    const config = makeNaxConfig({ models: { claude: { fast: { provider: "anthropic", model: "claude-haiku-4-5-20251001" }, balanced: { provider: "anthropic", model: "claude-sonnet-4-5" }, powerful: { provider: "anthropic", model: "claude-opus-4-5" } } }, agent: { default: "claude" as const }, acceptance: { model: "balanced" } });
    let receivedModel: string | undefined;

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string, _prompt: string, options: any) => {
          receivedModel = options?.model;
          return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
        },
      }),
    );

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(receivedModel).toBe("claude-sonnet-4-5");
  });

  test("does NOT call Bun.spawn directly — uses agentManager.complete()", async () => {
    const config = makeNaxConfig();
    const spawnCalls: unknown[] = [];
    const originalSpawn = Bun.spawn;

    (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
      spawnCalls.push(args);
      return originalSpawn(...(args as Parameters<typeof originalSpawn>));
    };

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string) => makeLLMResponse(SAMPLE_CRITERIA, STORY_ID),
      }),
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
    const config = makeNaxConfig();

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string) => makeLLMResponse(SAMPLE_CRITERIA, STORY_ID),
      }),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(Array.isArray(result.criteria)).toBe(true);
    expect(result.criteria).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result.criteria[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("returns RefinedCriterion[] with refined field from LLM response", async () => {
    const config = makeNaxConfig();

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string) => makeLLMResponse(SAMPLE_CRITERIA, STORY_ID),
      }),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    for (const item of result.criteria) {
      expect(typeof item.refined).toBe("string");
      expect(item.refined.length).toBeGreaterThan(0);
    }
  });

  test("passes a plain string prompt to agentManager.complete() (not SDK format)", async () => {
    const config = makeNaxConfig();
    let capturedPrompt: unknown;

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string, prompt: string) => {
          capturedPrompt = prompt;
          return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
        },
      }),
    );

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(typeof capturedPrompt).toBe("string");
  });

  test("prompt passed to agentManager.complete() contains all criteria", async () => {
    const config = makeNaxConfig();
    let capturedPrompt = "";

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string, prompt: string) => {
          capturedPrompt = prompt;
          return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
        },
      }),
    );

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    for (const criterion of SAMPLE_CRITERIA) {
      expect(capturedPrompt).toContain(criterion);
    }
  });

  test("prompt passed to agentManager.complete() contains codebase context", async () => {
    const config = makeNaxConfig();
    let capturedPrompt = "";

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string, prompt: string) => {
          capturedPrompt = prompt;
          return makeLLMResponse(SAMPLE_CRITERIA, STORY_ID);
        },
      }),
    );

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(capturedPrompt).toContain(CODEBASE_CONTEXT);
  });

  test("preserves criteria with testable:false in the result", async () => {
    const config = makeNaxConfig();

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string) => makeLLMResponse(SAMPLE_CRITERIA, STORY_ID, false),
      }),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(result.criteria).toHaveLength(SAMPLE_CRITERIA.length);
    for (const item of result.criteria) {
      expect(item.testable).toBe(false);
    }
  });

  test("assigns storyId from context to all RefinedCriterion items", async () => {
    const config = makeNaxConfig();
    const customStoryId = "STORY-XYZ";

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string) => makeLLMResponse(SAMPLE_CRITERIA, customStoryId),
      }),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: customStoryId,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    for (const item of result.criteria) {
      expect(item.storyId).toBe(customStoryId);
    }
  });

  test("handles empty criteria list without calling agentManager.complete()", async () => {
    const config = makeNaxConfig();
    let managerCreated = false;

    _refineDeps.createManager = mock(() => {
      managerCreated = true;
      return makeMockAgentManager({
        completeFn: async (_agent: string) => ({ output: "[]", costUsd: 0, source: "fallback" } satisfies CompleteResult),
      });
    });

    const result = await refineAcceptanceCriteria([], {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(result.criteria).toHaveLength(0);
    expect(managerCreated).toBe(false);
  });

  test("falls back to original text when agentManager.complete() returns malformed JSON", async () => {
    const config = makeNaxConfig();

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string) => ({ output: "not valid json at all {{{", costUsd: 0, source: "fallback" } satisfies CompleteResult),
      }),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(result.criteria).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result.criteria[i].original).toBe(SAMPLE_CRITERIA[i]);
      expect(result.criteria[i].refined).toBe(SAMPLE_CRITERIA[i]);
    }
  });

  test("falls back gracefully when agentManager.complete() throws", async () => {
    const config = makeNaxConfig();

    _refineDeps.createManager = mock(() =>
      makeMockAgentManager({
        completeFn: async (_agent: string) => {
          throw new Error("adapter network error");
        },
      }),
    );

    const result = await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    expect(Array.isArray(result.criteria)).toBe(true);
    expect(result.criteria).toHaveLength(SAMPLE_CRITERIA.length);
    for (let i = 0; i < SAMPLE_CRITERIA.length; i++) {
      expect(result.criteria[i].original).toBe(SAMPLE_CRITERIA[i]);
    }
  });
});
