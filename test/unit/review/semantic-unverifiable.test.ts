/**
 * Unit tests for unverifiable finding handling in src/review/semantic.ts
 *
 * Tests cover:
 * - "unverifiable" severity is treated as non-blocking (maps to "info")
 * - Findings with only unverifiable severity override to pass
 * - Mixed blocking + unverifiable findings: only blocking count
 * - Updated prompt includes tool-access verification instructions
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { makeMockAgentManager } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-010",
  title: "i18n key migration",
  description: "Migrate hardcoded strings to i18n keys",
  acceptanceCriteria: [
    "Component uses t('foo.bar') from i18n",
    "Locale files contain foo.bar key",
  ],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  excludePatterns: [":!test/", ":!tests/"],
  timeoutMs: 600_000,
};

function makeAgentManager(llmResponse: string, cost = 0) {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agent, opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCost: cost,
      agentFallbacks: [],
    }),
    completeFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" }),
    runWithFallbackFn: async () => ({ result: { success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCost: cost, agentFallbacks: [] }, fallbacks: [] }),
    completeWithFallbackFn: async () => ({ result: { output: llmResponse, costUsd: cost, source: "mock" }, fallbacks: [] }),
    runAsFn: async (_agent, opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCost: cost,
      agentFallbacks: [],
    }),
    completeAsFn: async (_agent, _prompt, _opts) => ({ output: llmResponse, costUsd: cost, source: "mock" }),
    planFn: async () => { throw new Error("not used"); },
    planAsFn: async () => { throw new Error("not used"); },
    decomposeFn: async () => { throw new Error("not used"); },
    decomposeAsFn: async () => { throw new Error("not used"); },
  });
}

function makeSpawnMock(stdout: string, exitCode = 0) {
  return mock((_opts: unknown) => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) { controller.close(); },
    }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

beforeEach(() => {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;

  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => "abc123");
  _diffUtilsDeps.spawn = makeSpawnMock("diff --git a/foo.vue b/foo.vue\n+import { useI18n } from 'vue-i18n'");
});

afterEach(() => {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("unverifiable finding handling", () => {
  test("unverifiable-only findings override to pass", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "unverifiable",
          file: "i18n/en.json",
          line: 10,
          issue: "Cannot confirm key exists from diff alone",
          suggestion: "Check the file",
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const result = await runSemanticReview(
      "/tmp/repo",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      agentManager,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("advisory");
  });

  test("mixed blocking + unverifiable: only blocking findings cause failure", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          file: "foo.vue",
          line: 5,
          issue: "AC not implemented",
          suggestion: "Implement it",
        },
        {
          severity: "unverifiable",
          file: "i18n/en.json",
          line: 10,
          issue: "Cannot confirm key exists",
          suggestion: "Check the file",
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const result = await runSemanticReview(
      "/tmp/repo",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      agentManager,
    );

    expect(result.success).toBe(false);
    // Only the blocking finding should be in the output
    expect(result.output).toContain("AC not implemented");
    expect(result.output).not.toContain("Cannot confirm key exists");
    // Only 1 finding in structured findings
    expect(result.findings?.length).toBe(1);
    expect(result.findings?.[0].message).toBe("AC not implemented");
  });

  test("info findings are advisory at default 'error' threshold (below blocking threshold)", async () => {
    const response = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "info",
          file: "foo.vue",
          line: 1,
          issue: "Minor observation",
          suggestion: "Consider this",
        },
      ],
    });
    const agentManager = makeAgentManager(response);
    const result = await runSemanticReview(
      "/tmp/repo",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      agentManager,
    );

    // With default 'error' threshold, info findings are advisory — not blocking
    expect(result.success).toBe(true);
    expect(result.output).toContain("advisory");
    expect(result.advisoryFindings).toBeDefined();
    expect(result.advisoryFindings![0].message).toBe("Minor observation");
  });
});

describe("semantic prompt includes tool-access instructions", () => {
  test("prompt instructs agent to verify with tools before flagging", async () => {
    let capturedPrompt = "";
    const agentManager = makeAgentManager(JSON.stringify({ passed: true, findings: [] }));
    (agentManager.run as ReturnType<typeof mock>).mockImplementation(async (args: { runOptions: { prompt: string } }) => {
      capturedPrompt = args.runOptions.prompt;
      return { success: true, exitCode: 0, output: JSON.stringify({ passed: true, findings: [] }), rateLimited: false, durationMs: 100, estimatedCost: 0 } as AgentResult;
    });

    await runSemanticReview(
      "/tmp/repo",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      agentManager,
    );

    expect(capturedPrompt).toContain("you MUST verify it using your tools");
    expect(capturedPrompt).toContain("READ the relevant file");
    expect(capturedPrompt).toContain("GREP for its usage");
    expect(capturedPrompt).toContain("Do NOT flag something as missing based solely on its absence from the diff");
    expect(capturedPrompt).toContain("unverifiable");
  });
});
