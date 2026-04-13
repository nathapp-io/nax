/**
 * Unit tests for the JSON retry logic in src/review/semantic.ts
 *
 * Tests cover:
 * - Retry succeeds: initial response unparseable, retry returns valid JSON
 * - Retry failure: retry call throws, falls through to fail-open
 * - agent.run called twice when initial response is unparseable
 * - Retry call uses keepSessionOpen: false
 * - Cost accumulated from both initial and retry calls
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";
import type { AgentAdapter } from "../../../src/agents/types";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-002",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: [
    "runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig, and modelResolver",
  ],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      start(controller) {
        controller.close();
      },
    }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

/**
 * Build a mock AgentAdapter whose run() returns a different response per call.
 * responses[0] is returned on the first call, responses[1] on the second, etc.
 * The last entry is reused for any additional calls beyond the array length.
 */
function makeMultiCallAgent(responses: string[], costPerCall = 0.5): AgentAdapter {
  let callIndex = 0;
  const agentResultFor = (output: string): AgentResult => ({
    success: true,
    exitCode: 0,
    output,
    rateLimited: false,
    durationMs: 100,
    estimatedCost: costPerCall,
  });
  return {
    name: "mock",
    displayName: "Mock Multi-Call Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: [],
      maxContextTokens: 128_000,
      features: new Set(),
    } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return agentResultFor(response);
    }),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    complete: mock(async (_prompt: string) => {
      throw new Error("complete() must NOT be called in non-debate path");
    }),
  } as unknown as AgentAdapter;
}

// ---------------------------------------------------------------------------
// Saved deps
// ---------------------------------------------------------------------------

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
let origWriteReviewAudit: typeof _semanticDeps.writeReviewAudit;

function saveAllDeps() {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _semanticDeps.writeReviewAudit;
}

function restoreAllDeps() {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _semanticDeps.writeReviewAudit = origWriteReviewAudit;
}

function setupHappyPathDeps() {
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = makeSpawnMock("src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)");
  _semanticDeps.writeReviewAudit = mock(async () => {});
}

// ---------------------------------------------------------------------------
// JSON retry — success path
// ---------------------------------------------------------------------------

describe("runSemanticReview — JSON retry succeeds", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("uses valid JSON from retry when initial response is unparseable", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_LLM_RESPONSE]);

    const result = await runSemanticReview(
      "/tmp/wd",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Semantic review passed");
  });

  test("agent.run called twice when initial response is unparseable", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect((agent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });

  test("retry call uses keepSessionOpen: false to close the session", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const calls = (agent.run as ReturnType<typeof mock>).mock.calls;
    expect((calls[1][0] as Record<string, unknown>).keepSessionOpen).toBe(false);
  });

  test("agent.run called once when initial response is valid JSON", async () => {
    const agent = makeMultiCallAgent([PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect((agent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test("cost accumulated from both initial and retry calls", async () => {
    const agent = makeMultiCallAgent(["not json", PASSING_LLM_RESPONSE], 0.5);

    const result = await runSemanticReview(
      "/tmp/wd",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => agent,
    );

    expect(result.cost).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// JSON retry — failure paths
// ---------------------------------------------------------------------------

describe("runSemanticReview — JSON retry failure paths", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("falls through to fail-open when retry call throws", async () => {
    let callIndex = 0;
    const agent = {
      name: "mock",
      displayName: "Mock Agent",
      binary: "mock",
      capabilities: {
        supportedTiers: [],
        maxContextTokens: 128_000,
        features: new Set(),
      } as unknown as AgentAdapter["capabilities"],
      isInstalled: mock(async () => true),
      run: mock(async () => {
        callIndex++;
        if (callIndex === 1) {
          return { success: true, exitCode: 0, output: "not json at all", rateLimited: false, durationMs: 100, estimatedCost: 0 } as AgentResult;
        }
        throw new Error("retry connection failure");
      }),
      buildCommand: mock(() => []),
      plan: mock(async () => { throw new Error("not used"); }),
      decompose: mock(async () => { throw new Error("not used"); }),
      complete: mock(async (_prompt: string) => { throw new Error("not used"); }),
    } as unknown as AgentAdapter;

    const result = await runSemanticReview(
      "/tmp/wd",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("fail-open");
  });

  test("fails closed when retry also returns truncated JSON with passed:false", async () => {
    const truncated = '{ "passed": false, "findings": [{ "severity": "error"';
    const agent = makeMultiCallAgent(["not json", truncated]);

    const result = await runSemanticReview(
      "/tmp/wd",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("passed:false");
  });
});
