/**
 * Unit tests for src/review/semantic.ts
 * Split 3: BUG-114 storyGitRef merge-base fallback, agent.run() vs complete(), session naming
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { computeAcpHandle } from "../../../src/agents/acp/adapter";
import type { AgentResult } from "../../../src/agents/types";
import type { IAgentManager } from "../../../src/agents/manager-types";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { makeMockAgentManager } from "../../helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-002",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: [
    "runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig, and modelResolver",
    "It calls git diff --unified=3 storyGitRef..HEAD",
  ],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [":!test/", ":!tests/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts", ":!**/__tests__/", ":!.nax/", ":!.nax-pids"],
};

function makeAgentManager(llmResponse: string, cost = 0): IAgentManager {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agentName: string, _opts: unknown) => ({
      success: true as const,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCost: cost,
      agentFallbacks: [] as unknown[],
    }),
    completeFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" as const }),
  });
}

function makeRunAgentManager(output: string, success = true): IAgentManager {
  const agentResult: AgentResult = {
    success,
    exitCode: success ? 0 : 1,
    output,
    rateLimited: false,
    durationMs: 100,
    estimatedCost: 0,
  };

  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agentName: string, _opts: unknown) => ({
      ...agentResult,
      agentFallbacks: [] as unknown[],
    }),
    completeFn: async () => {
      throw new Error("complete() must NOT be called in non-debate path (US-003)");
    },
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
      start(controller) {
        controller.close();
      },
    }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });
const FAILING_LLM_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      file: "src/review/semantic.ts",
      line: 42,
      issue: "Function is a stub",
      suggestion: "Implement the function",
    },
  ],
});

// ---------------------------------------------------------------------------
// BUG-114: storyGitRef fallback — merge-base when ref is missing or invalid
// ---------------------------------------------------------------------------

describe("runSemanticReview — BUG-114 storyGitRef fallback (merge-base)", () => {
  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _diffUtilsDeps.spawn;
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
  });

  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
  });

  test("uses effectiveRef = storyGitRef when ref is valid", async () => {
    const spawnMock = makeSpawnMock("diff content", 0);
    _diffUtilsDeps.spawn = spawnMock;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => "merge-base-sha");
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", "valid-sha", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    expect(spawnMock).toHaveBeenCalled();
    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cmd: string[] };
    expect(spawnOpts.cmd).toContain("valid-sha..HEAD");
    expect(_diffUtilsDeps.getMergeBase).not.toHaveBeenCalled();
  });

  test("falls back to merge-base when storyGitRef is undefined", async () => {
    const spawnMock = makeSpawnMock("diff content", 0);
    _diffUtilsDeps.spawn = spawnMock;
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => "abc-merge-base");
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    expect(spawnMock).toHaveBeenCalled();
    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cmd: string[] };
    expect(spawnOpts.cmd).toContain("abc-merge-base..HEAD");
  });

  test("falls back to merge-base when storyGitRef is invalid (e.g. after rebase)", async () => {
    const spawnMock = makeSpawnMock("diff content", 0);
    _diffUtilsDeps.spawn = spawnMock;
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => "fallback-merge-base-sha");
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", "stale-sha-after-rebase", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    expect(spawnMock).toHaveBeenCalled();
    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cmd: string[] };
    expect(spawnOpts.cmd).toContain("fallback-merge-base-sha..HEAD");
    expect(_diffUtilsDeps.isGitRefValid).toHaveBeenCalledWith("/tmp/wd", "stale-sha-after-rebase");
  });

  test("skips review (success=true) when storyGitRef is undefined and merge-base is also unavailable", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, undefined);

    expect(result.success).toBe(true);
    expect(result.output).toContain("skipped: no git ref");
  });

  test("skips review (success=true) when storyGitRef is invalid and merge-base is also unavailable", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);

    const result = await runSemanticReview("/tmp/wd", "bad-sha", STORY, DEFAULT_SEMANTIC_CONFIG, undefined);

    expect(result.success).toBe(true);
    expect(result.output).toContain("skipped: no git ref");
  });
});

// ---------------------------------------------------------------------------
// US-003: agent.run() replaces agent.complete() in the non-debate path
// ---------------------------------------------------------------------------

describe("runSemanticReview — uses agent.run() instead of agent.complete() (US-003)", () => {
  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _diffUtilsDeps.spawn;
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    _diffUtilsDeps.spawn = makeSpawnMock("some diff content", 0);
  });

  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
  });

  test("calls agent.run() for the non-debate path", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(agentManager.run).toHaveBeenCalled();
  });

  test("does NOT call agent.complete() for the non-debate path", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(agentManager.complete).not.toHaveBeenCalled();
  });

  test("agent.run() receives sessionRole='reviewer-semantic' and featureName for own session (#414)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const workdir = "/my/project";
    const featureName = "my-feature";

    await runSemanticReview(workdir, "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager, undefined, featureName);

    expect(agentManager.run).toHaveBeenCalled();
    const runOpts = (agentManager.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    const runOptions = runOpts.runOptions as Record<string, unknown>;
    expect(runOptions.sessionRole).toBe("reviewer-semantic");
    expect(runOptions.featureName).toBe(featureName);
    const expectedSession = computeAcpHandle(workdir, featureName, STORY.id, "reviewer-semantic");
    expect(expectedSession).toMatch(/^nax-[a-f0-9]+-my-feature-.+-reviewer-semantic$/);
  });

  test("agent.run() initial call uses keepOpen: true (session kept open for JSON retry)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(agentManager.run).toHaveBeenCalled();
    const runOpts = (agentManager.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    const runOptions = runOpts.runOptions as Record<string, unknown>;
    expect(runOptions.keepOpen).toBe(true);
  });

  test("session handle encodes workdir hash in session name (via computeAcpHandle)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const workdirA = "/project/alpha";
    const workdirB = "/project/beta";
    const sessionA = computeAcpHandle(workdirA, "feat", STORY.id, "reviewer-semantic");
    const sessionB = computeAcpHandle(workdirB, "feat", STORY.id, "reviewer-semantic");

    await runSemanticReview(workdirA, "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager, undefined, "feat");
    const runOptsA = (agentManager.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    const runOptionsA = runOptsA.runOptions as Record<string, unknown>;

    expect(sessionA).not.toBe(sessionB);
    expect(runOptionsA.featureName).toBe("feat");
    expect(runOptionsA.storyId).toBe(STORY.id);
  });

  test("session handle encodes featureName in session name (via computeAcpHandle)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const featureName = "semantic-continuity";
    const expectedSession = computeAcpHandle("/tmp/wd", featureName, STORY.id, "reviewer-semantic");

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager, undefined, featureName);

    const runOpts = (agentManager.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    const runOptions = runOpts.runOptions as Record<string, unknown>;
    expect(runOptions.featureName).toBe(featureName);
    expect(expectedSession).toContain("semantic-continuity");
  });

  test("session handle encodes storyId in session name (via computeAcpHandle)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const storyWithDifferentId: SemanticStory = { ...STORY, id: "US-999" };
    const expectedSession = computeAcpHandle("/tmp/wd", "feat", "US-999", "reviewer-semantic");

    await runSemanticReview("/tmp/wd", "abc123", storyWithDifferentId, DEFAULT_SEMANTIC_CONFIG, agentManager, undefined, "feat");

    const runOpts = (agentManager.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    const runOptions = runOpts.runOptions as Record<string, unknown>;
    expect(runOptions.storyId).toBe("US-999");
    expect(expectedSession).toContain("us-999");
  });

  test("extracts rawResponse from AgentRunResult.output field — passed=true", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(true);
    expect(result.output).toContain("Semantic review passed");
  });

  test("extracts rawResponse from AgentRunResult.output field — passed=false with findings", async () => {
    const agentManager = makeRunAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Function is a stub");
  });

  test("ReviewCheckResult has check='semantic' field after run() path", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.check).toBe("semantic");
  });

  test("ReviewCheckResult has exitCode=0 when run() returns passed=true", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.exitCode).toBe(0);
  });

  test("ReviewCheckResult has exitCode=1 when run() returns passed=false", async () => {
    const agentManager = makeRunAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.exitCode).toBe(1);
  });

  test("ReviewCheckResult has command='' field", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.command).toBe("");
  });

  test("ReviewCheckResult has durationMs field as number", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(typeof result.durationMs).toBe("number");
  });

  test("ReviewCheckResult includes findings when run() output has failing findings", async () => {
    const agentManager = makeRunAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);
    expect((result.findings?.length ?? 0)).toBeGreaterThan(0);
  });
});
