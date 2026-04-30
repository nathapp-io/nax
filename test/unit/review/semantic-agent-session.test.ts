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
import { makeAgentAdapter, makeMockAgentManager, makeMockRuntime } from "../../helpers";

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
  model: "balanced",
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
      estimatedCostUsd: cost,
      agentFallbacks: [] as unknown[],
    }),
    completeFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" as const }),
    runWithFallbackFn: async (request) => {
      const result = {
        success: true as const,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: cost,
        agentFallbacks: [] as unknown[],
      };
      return { result, fallbacks: [], bundle: request.bundle };
    },
    completeWithFallbackFn: async () => ({
      result: { output: llmResponse, costUsd: cost, source: "mock" as const },
      fallbacks: [],
    }),
    getAgentFn: () => makeAgentAdapter(),
  });
}

function makeRunAgentManager(output: string, success = true): IAgentManager {
  const agentResult: AgentResult = {
    success,
    exitCode: success ? 0 : 1,
    output,
    rateLimited: false,
    durationMs: 100,
    estimatedCostUsd: 0,
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
    runWithFallbackFn: async (request) => {
      const result = { ...agentResult, agentFallbacks: [] as unknown[] };
      return { result, fallbacks: [], bundle: request.bundle };
    },
    completeWithFallbackFn: async () => {
      throw new Error("complete() must NOT be called in non-debate path (US-003)");
    },
    getAgentFn: () => makeAgentAdapter(),
  });
}

function makeRuntime(agentManager: IAgentManager) {
  return makeMockRuntime({ agentManager });
}

async function callRunSemanticReview(agentManager: IAgentManager): Promise<import("../../../src/review/types").ReviewCheckResult> {
  return runSemanticReview({
    workdir: "/tmp/wd",
    storyGitRef: "abc123",
    story: STORY,
    semanticConfig: DEFAULT_SEMANTIC_CONFIG,
    agentManager,
    runtime: makeRuntime(agentManager),
  });
}

async function callRunSemanticReviewWithFeature(
  agentManager: IAgentManager,
  featureName?: string,
): Promise<import("../../../src/review/types").ReviewCheckResult> {
  return runSemanticReview({
    workdir: "/tmp/wd",
    storyGitRef: "abc123",
    story: STORY,
    semanticConfig: DEFAULT_SEMANTIC_CONFIG,
    agentManager,
    featureName,
    runtime: makeRuntime(agentManager),
  });
}

async function callSemanticReviewWithRef(
  storyGitRef: string | undefined,
  agentManager: IAgentManager | undefined,
): Promise<import("../../../src/review/types").ReviewCheckResult> {
  return runSemanticReview({
    workdir: "/tmp/wd",
    storyGitRef,
    story: STORY,
    semanticConfig: DEFAULT_SEMANTIC_CONFIG,
    agentManager,
    runtime: agentManager ? makeRuntime(agentManager) : undefined,
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

    await callSemanticReviewWithRef("valid-sha", agentManager);

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

    await callSemanticReviewWithRef(undefined, agentManager);

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

    await callSemanticReviewWithRef("stale-sha-after-rebase", agentManager);

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

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: undefined,
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("skipped: no git ref");
  });

  test("skips review (success=true) when storyGitRef is invalid and merge-base is also unavailable", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "bad-sha",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
    });

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

  test("calls agent.runWithFallback() for the non-debate path", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    await callRunSemanticReview(agentManager);
    expect(agentManager.runWithFallback).toHaveBeenCalled();
  });

  test("does NOT call agent.complete() for the non-debate path", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    await callRunSemanticReview(agentManager);
    expect(agentManager.complete).not.toHaveBeenCalled();
  });

  test("agent.runWithFallback() receives sessionRole='reviewer-semantic' and featureName for own session (#414)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const featureName = "my-feature";

    await callRunSemanticReviewWithFeature(agentManager, featureName);

    expect(agentManager.runWithFallback).toHaveBeenCalled();
    const req = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0][0] as { runOptions: Record<string, unknown> };
    const runOptions = req.runOptions;
    expect(runOptions.sessionRole).toBe("reviewer-semantic");
    expect(runOptions.featureName).toBe(featureName);
    const expectedSession = computeAcpHandle("/tmp/wd", featureName, STORY.id, "reviewer-semantic");
    expect(expectedSession).toMatch(/^nax-[a-f0-9]+-my-feature-.+-reviewer-semantic$/);
  });

  test("ADR-019: session is managed explicitly via openSession+runAsSession+closeSession (keepOpen is not used)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    await callRunSemanticReview(agentManager);
    expect(agentManager.runWithFallback).toHaveBeenCalled();
    const req = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0][0] as { runOptions: Record<string, unknown> };
    // Legacy keepOpen option is not present in the ADR-019 runtime path;
    // session lifecycle is owned by buildHopCallback.
    expect(req.runOptions.keepOpen).toBeUndefined();
  });

  test("session handle encodes workdir hash in session name (via computeAcpHandle)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const workdirA = "/project/alpha";
    const workdirB = "/project/beta";
    const sessionA = computeAcpHandle(workdirA, "feat", STORY.id, "reviewer-semantic");
    const sessionB = computeAcpHandle(workdirB, "feat", STORY.id, "reviewer-semantic");

    await callRunSemanticReviewWithFeature(agentManager, "feat");

    expect(sessionA).not.toBe(sessionB);
  });

  test("session handle encodes featureName in session name (via computeAcpHandle)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const featureName = "semantic-continuity";

    await callRunSemanticReviewWithFeature(agentManager, featureName);

    expect(agentManager.runWithFallback).toHaveBeenCalled();
    const req = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0][0] as { runOptions: Record<string, unknown> };
    expect(req.runOptions.featureName).toBe(featureName);
  });

  test("session handle encodes storyId in session name (via computeAcpHandle)", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const storyWithDifferentId: SemanticStory = { ...STORY, id: "US-999" };

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: storyWithDifferentId,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      featureName: "feat",
      runtime: makeRuntime(agentManager),
    });

    expect(agentManager.runWithFallback).toHaveBeenCalled();
    const req = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0][0] as { runOptions: Record<string, unknown> };
    expect(req.runOptions.storyId).toBe("US-999");
  });

  test("extracts rawResponse from AgentRunResult.output field — passed=true", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await callRunSemanticReview(agentManager);
    expect(result.success).toBe(true);
    expect(result.output).toContain("Semantic review passed");
  });

  test("extracts rawResponse from AgentRunResult.output field — passed=false with findings", async () => {
    const agentManager = makeRunAgentManager(FAILING_LLM_RESPONSE);
    const result = await callRunSemanticReview(agentManager);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Function is a stub");
  });

  test("ReviewCheckResult has check='semantic' field after run() path", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await callRunSemanticReview(agentManager);
    expect(result.check).toBe("semantic");
  });

  test("ReviewCheckResult has exitCode=0 when run() returns passed=true", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await callRunSemanticReview(agentManager);
    expect(result.exitCode).toBe(0);
  });

  test("ReviewCheckResult has exitCode=1 when run() returns passed=false", async () => {
    const agentManager = makeRunAgentManager(FAILING_LLM_RESPONSE);
    const result = await callRunSemanticReview(agentManager);
    expect(result.exitCode).toBe(1);
  });

  test("ReviewCheckResult has command='' field", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await callRunSemanticReview(agentManager);
    expect(result.command).toBe("");
  });

  test("ReviewCheckResult has durationMs field as number", async () => {
    const agentManager = makeRunAgentManager(PASSING_LLM_RESPONSE);
    const result = await callRunSemanticReview(agentManager);
    expect(typeof result.durationMs).toBe("number");
  });

  test("ReviewCheckResult includes findings when run() output has failing findings", async () => {
    const agentManager = makeRunAgentManager(FAILING_LLM_RESPONSE);
    const result = await callRunSemanticReview(agentManager);
    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);
    expect((result.findings?.length ?? 0)).toBeGreaterThan(0);
  });
});
