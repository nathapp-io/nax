/**
 * Tests for ACS-004: Strategy-aware refinement prompt
 *
 * Covers:
 * - RefinementContext has optional testStrategy and testFramework fields
 * - buildRefinementPrompt includes strategy-specific instructions for 'component'
 * - buildRefinementPrompt includes strategy-specific instructions for 'cli'
 * - buildRefinementPrompt includes strategy-specific instructions for 'e2e'
 * - buildRefinementPrompt omits strategy instructions when testStrategy is unset
 * - Strategy context appears in the prompt sent to the LLM
 * - testFramework is included in the prompt when provided
 * - refineAcceptanceCriteria propagates testStrategy/testFramework to the prompt
 */

import { describe, expect, mock, test } from "bun:test";
import {
  _refineDeps,
  refineAcceptanceCriteria,
} from "../../../src/acceptance/refinement";
import { AcceptancePromptBuilder } from "../../../src/prompts";
import type { RefinementContext } from "../../../src/acceptance/types";
import { makeMockAgentManager, makeNaxConfig } from "../../helpers";

const buildRefinementPrompt = (
  criteria: string[],
  ctx: string,
  opts?: Parameters<AcceptancePromptBuilder["buildRefinementPrompt"]>[2],
) => new AcceptancePromptBuilder().buildRefinementPrompt(criteria, ctx, opts);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const STORY_ID = "ACS-004";
const SAMPLE_CRITERIA = [
  "User sees rendered output on screen",
  "CLI command exits with status 0",
];
const CODEBASE_CONTEXT = "File tree:\nsrc/\n  acceptance/\n    refinement.ts\n";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers for saving/restoring _refineDeps.createManager
// ─────────────────────────────────────────────────────────────────────────────

let savedAgentManager: typeof _refineDeps.agentManager;

function saveCreateManager() {
  savedAgentManager = _refineDeps.agentManager;
}

function restoreCreateManager() {
  _refineDeps.agentManager = savedAgentManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: RefinementContext has optional testStrategy and testFramework fields
// ─────────────────────────────────────────────────────────────────────────────

describe("RefinementContext — optional testStrategy and testFramework fields", () => {
  test("accepts RefinementContext without testStrategy or testFramework", () => {
    const ctx: RefinementContext = {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config: makeNaxConfig(),
    };
    expect(ctx.testStrategy).toBeUndefined();
    expect(ctx.testFramework).toBeUndefined();
  });

  test("accepts RefinementContext with testStrategy set to 'component'", () => {
    const ctx: RefinementContext = {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config: makeNaxConfig(),
      testStrategy: "component",
    };
    expect(ctx.testStrategy).toBe("component");
  });

  test("accepts RefinementContext with testStrategy set to 'cli'", () => {
    const ctx: RefinementContext = {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config: makeNaxConfig(),
      testStrategy: "cli",
    };
    expect(ctx.testStrategy).toBe("cli");
  });

  test("accepts RefinementContext with testStrategy set to 'e2e'", () => {
    const ctx: RefinementContext = {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config: makeNaxConfig(),
      testStrategy: "e2e",
    };
    expect(ctx.testStrategy).toBe("e2e");
  });

  test("accepts RefinementContext with testFramework set", () => {
    const ctx: RefinementContext = {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config: makeNaxConfig(),
      testStrategy: "component",
      testFramework: "ink-testing-library",
    };
    expect(ctx.testFramework).toBe("ink-testing-library");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2 & AC-4: Component strategy prompt instructions
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRefinementPrompt — component strategy", () => {
  test("includes component strategy instructions when testStrategy is 'component'", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "component",
    });

    expect(prompt).toContain("component");
  });

  test("instructs LLM to assert about rendered text output for 'component' strategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "component",
    });

    // Prompt must guide toward rendered output assertions, not function return values
    const lowerPrompt = prompt.toLowerCase();
    const hasRenderedOutputInstruction =
      lowerPrompt.includes("render") ||
      lowerPrompt.includes("rendered") ||
      lowerPrompt.includes("visible") ||
      lowerPrompt.includes("text content") ||
      lowerPrompt.includes("screen");
    expect(hasRenderedOutputInstruction).toBe(true);
  });

  test("does NOT instruct about function return values for 'component' strategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "component",
    });

    // Must guide away from function-return-value assertions
    const lowerPrompt = prompt.toLowerCase();
    const mentionsFunctionReturn =
      lowerPrompt.includes("function returns") || lowerPrompt.includes("return value");
    expect(mentionsFunctionReturn).toBe(false);
  });

  test("includes testFramework in prompt when provided with 'component' strategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "component",
      testFramework: "ink-testing-library",
    });

    expect(prompt).toContain("ink-testing-library");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 & AC-5: CLI strategy prompt instructions
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRefinementPrompt — cli strategy", () => {
  test("includes cli strategy instructions when testStrategy is 'cli'", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "cli",
    });

    expect(prompt).toContain("cli");
  });

  test("instructs LLM to assert about stdout content for 'cli' strategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "cli",
    });

    const lowerPrompt = prompt.toLowerCase();
    const hasStdoutInstruction =
      lowerPrompt.includes("stdout") ||
      lowerPrompt.includes("stderr") ||
      lowerPrompt.includes("standard output") ||
      lowerPrompt.includes("terminal output");
    expect(hasStdoutInstruction).toBe(true);
  });

  test("includes testFramework in prompt when provided with 'cli' strategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "cli",
      testFramework: "bun:test",
    });

    expect(prompt).toContain("bun:test");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E strategy
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRefinementPrompt — e2e strategy", () => {
  test("instructs LLM to assert about HTTP response content for 'e2e' strategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "e2e",
    });

    const lowerPrompt = prompt.toLowerCase();
    const hasHttpInstruction =
      lowerPrompt.includes("http") ||
      lowerPrompt.includes("response") ||
      lowerPrompt.includes("status code") ||
      lowerPrompt.includes("endpoint");
    expect(hasHttpInstruction).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: Unset testStrategy — backward compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe("buildRefinementPrompt — no testStrategy (backward compatibility)", () => {
  test("returns a valid prompt without testStrategy arg", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("includes all criteria in prompt when no testStrategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    for (const criterion of SAMPLE_CRITERIA) {
      expect(prompt).toContain(criterion);
    }
  });

  test("includes codebase context in prompt when no testStrategy", () => {
    const prompt = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    expect(prompt).toContain(CODEBASE_CONTEXT);
  });

  test("does not include component-specific instructions when testStrategy is omitted", () => {
    const withStrategy = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "component",
    });
    const withoutStrategy = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    // The no-strategy prompt should differ from the component-strategy prompt
    expect(withoutStrategy).not.toBe(withStrategy);
  });

  test("does not include cli-specific instructions when testStrategy is omitted", () => {
    const withStrategy = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT, {
      testStrategy: "cli",
    });
    const withoutStrategy = buildRefinementPrompt(SAMPLE_CRITERIA, CODEBASE_CONTEXT);

    expect(withoutStrategy).not.toBe(withStrategy);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: Strategy context appears in the system prompt sent to the LLM
// ─────────────────────────────────────────────────────────────────────────────

describe("refineAcceptanceCriteria — strategy propagated to LLM prompt", () => {
  test("propagates 'component' testStrategy into the prompt passed to adapter.complete()", async () => {
    saveCreateManager();
    const config = makeNaxConfig();
    let capturedPrompt = "";

    _refineDeps.agentManager = makeMockAgentManager({
        completeFn: async (_agent: string, prompt: string) => {
          capturedPrompt = prompt;
          return {
            output: JSON.stringify(
              SAMPLE_CRITERIA.map((c) => ({
                original: c,
                refined: `Verify rendered: ${c}`,
                testable: true,
                storyId: STORY_ID,
              })),
            ),
            costUsd: 0,
            source: "mock" as const,
          };
        },
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
      testStrategy: "component",
    });
    restoreCreateManager();

    // The prompt sent to the LLM must include component-specific context
    const lowerPrompt = capturedPrompt.toLowerCase();
    const hasStrategyContext =
      lowerPrompt.includes("component") ||
      lowerPrompt.includes("render") ||
      lowerPrompt.includes("screen");
    expect(hasStrategyContext).toBe(true);
  });

  test("propagates 'cli' testStrategy into the prompt passed to adapter.complete()", async () => {
    saveCreateManager();
    const config = makeNaxConfig();
    let capturedPrompt = "";

    _refineDeps.agentManager = makeMockAgentManager({
        completeFn: async (_agent: string, prompt: string) => {
          capturedPrompt = prompt;
          return {
            output: JSON.stringify(
              SAMPLE_CRITERIA.map((c) => ({
                original: c,
                refined: `Verify stdout: ${c}`,
                testable: true,
                storyId: STORY_ID,
              })),
            ),
            costUsd: 0,
            source: "mock" as const,
          };
        },
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
      testStrategy: "cli",
    });
    restoreCreateManager();

    const lowerPrompt = capturedPrompt.toLowerCase();
    const hasStrategyContext =
      lowerPrompt.includes("cli") ||
      lowerPrompt.includes("stdout") ||
      lowerPrompt.includes("stderr");
    expect(hasStrategyContext).toBe(true);
  });

  test("propagates testFramework into the prompt passed to adapter.complete()", async () => {
    saveCreateManager();
    const config = makeNaxConfig();
    let capturedPrompt = "";

    _refineDeps.agentManager = makeMockAgentManager({
        completeFn: async (_agent: string, prompt: string) => {
          capturedPrompt = prompt;
          return {
            output: JSON.stringify(
              SAMPLE_CRITERIA.map((c) => ({
                original: c,
                refined: `Verify: ${c}`,
                testable: true,
                storyId: STORY_ID,
              })),
            ),
            costUsd: 0,
            source: "mock" as const,
          };
        },
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
      testStrategy: "component",
      testFramework: "ink-testing-library",
    });
    restoreCreateManager();

    expect(capturedPrompt).toContain("ink-testing-library");
  });

  test("prompt does not include strategy instructions when testStrategy is unset", async () => {
    saveCreateManager();
    const config = makeNaxConfig();
    let capturedPromptNoStrategy = "";
    let capturedPromptWithStrategy = "";

    _refineDeps.agentManager = makeMockAgentManager({
        completeFn: async (_agent: string, prompt: string) => {
          capturedPromptNoStrategy = prompt;
          return {
            output: JSON.stringify(
              SAMPLE_CRITERIA.map((c) => ({
                original: c,
                refined: `Verify: ${c}`,
                testable: true,
                storyId: STORY_ID,
              })),
            ),
            costUsd: 0,
            source: "mock" as const,
          };
        },
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
    });

    _refineDeps.agentManager = makeMockAgentManager({
        completeFn: async (_agent: string, prompt: string) => {
          capturedPromptWithStrategy = prompt;
          return {
            output: JSON.stringify(
              SAMPLE_CRITERIA.map((c) => ({
                original: c,
                refined: `Verify rendered: ${c}`,
                testable: true,
                storyId: STORY_ID,
              })),
            ),
            costUsd: 0,
            source: "mock" as const,
          };
        },
    });

    await refineAcceptanceCriteria(SAMPLE_CRITERIA, {
      storyId: STORY_ID,
      codebaseContext: CODEBASE_CONTEXT,
      config,
      testStrategy: "component",
    });
    restoreCreateManager();

    // Prompts should differ — strategy adds extra instructions
    expect(capturedPromptNoStrategy).not.toBe(capturedPromptWithStrategy);
  });
});
