/**
 * Unit tests for semantic.ts — multi-tier JSON parsing hardening
 *
 * Tests cover the two observed production failure modes:
 * 1. Preamble + fenced JSON (LLM narrates before ```json block)
 * 2. Bare JSON embedded in narration (no fences)
 * 3. Trailing commas in JSON (common LLM quirk)
 * 4. Pure narration — still fail-open (no regression)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { AgentResult } from "../../../src/agents/types";
import { makeAgentAdapter, makeMockAgentManager, makeMockRuntime } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers (mirrors semantic.test.ts patterns)
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-parse-01",
  title: "Parsing hardening test",
  description: "Ensure LLM response parser handles all output patterns",
  acceptanceCriteria: ["Parser handles preamble + fenced JSON", "Parser handles bare JSON in narration"],
};

const CONFIG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  excludePatterns: [],
  timeoutMs: 60_000,
};

function makeAgentManager(response: string, cost = 0) {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agent, opts) => ({
      success: true,
      exitCode: 0,
      output: response,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeFn: async () => ({ output: response, costUsd: cost, source: "mock" }),
    runWithFallbackFn: async (request) => {
      const result = {
        success: true,
        exitCode: 0,
        output: response,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: cost,
        agentFallbacks: [] as unknown[],
      };
      return { result, fallbacks: [], bundle: request.bundle };
    },
    completeWithFallbackFn: async () => ({ result: { output: response, costUsd: cost, source: "mock" }, fallbacks: [] }),
    runAsFn: async () => ({
      success: true,
      exitCode: 0,
      output: response,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [] as unknown[],
    }),
    completeAsFn: async () => ({ output: response, costUsd: cost, source: "mock" }),
    getAgentFn: () => makeAgentAdapter(),
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
// Test suite
// ---------------------------------------------------------------------------

describe("runSemanticReview — multi-tier JSON parsing", () => {
  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _diffUtilsDeps.spawn;
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
  });

  // ADR-019 migration helper: hoists agentManager so the runtime can wrap it,
  // then calls runSemanticReview with both. Tests must dispatch through the
  // runtime path (callOp → runWithFallback) so they keep working after the
  // legacy agentManager.run() fallback is removed.
  async function callRunSemanticReview(response: string) {
    const agentManager = makeAgentManager(response);
    const runtime = makeMockRuntime({ agentManager });
    return runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: CONFIG,
      agentManager,
      runtime,
    });
  }

  // Failure mode 2: preamble + fenced JSON (production log pattern)
  test("parses passed=true from preamble + ```json fence", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const response =
      "I'll verify each acceptance criterion by reading the actual implementation files.\n" +
      "```json\n" +
      JSON.stringify({ passed: true, findings: [] }) +
      "\n```";
    const result = await callRunSemanticReview(response);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("could not parse");
  });

  test("parses passed=false with findings from preamble + fence", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const payload = {
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", line: 10, issue: "missing impl", suggestion: "implement it" }],
    };
    const response =
      "Let me check the implementation.\n```json\n" + JSON.stringify(payload) + "\n```";
    const result = await callRunSemanticReview(response);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Semantic review failed");
  });

  test("parses from preamble + plain ``` fence", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const response =
      "After reviewing the diff:\n" +
      "```\n" +
      JSON.stringify({ passed: true, findings: [] }) +
      "\n```";
    const result = await callRunSemanticReview(response);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("could not parse");
  });

  // Bare JSON embedded in narration (tier 3)
  test("parses passed=true from JSON embedded in narration", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const response =
      'After analysis: {"passed":true,"findings":[]} All ACs are correctly implemented.';
    const result = await callRunSemanticReview(response);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("could not parse");
  });

  test("parses passed=false from JSON embedded in narration", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const payload = {
      passed: false,
      findings: [{ severity: "error", file: "src/bar.ts", line: 5, issue: "stub", suggestion: "implement" }],
    };
    const response = "I found issues. " + JSON.stringify(payload) + " That concludes my review.";
    const result = await callRunSemanticReview(response);
    expect(result.success).toBe(false);
  });

  // Trailing commas
  test("parses JSON with trailing commas in fence", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const response = '```json\n{"passed":true,"findings":[],}\n```';
    const result = await callRunSemanticReview(response);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("could not parse");
  });

  // Failure mode 1: pure narration — must still fail-open
  test("still fails-open on pure narration with no JSON", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const response =
      "I'll verify each acceptance criterion by examining the actual files to ensure all i18n keys exist and are correctly wired.";
    const result = await callRunSemanticReview(response);
    expect(result.success).toBe(true);
    expect(result.output).toContain("fail-open");
  });

  // Tier 1: clean JSON still works
  test("tier 1 still parses clean JSON directly", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const response = JSON.stringify({ passed: true, findings: [] });
    const result = await callRunSemanticReview(response);
    expect(result.success).toBe(true);
  });
});
