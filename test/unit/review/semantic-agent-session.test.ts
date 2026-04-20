/**
 * Unit tests for src/review/semantic.ts
 * Split 3: BUG-114 storyGitRef merge-base fallback, agent.run() vs complete(), session naming
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { computeAcpHandle } from "../../../src/agents/acp/adapter";
import type { AgentResult } from "../../../src/agents/types";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import type { AgentAdapter } from "../../../src/agents/types";

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

function makeMockAgent(response: string): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: { supportedTiers: [], supportedTestStrategies: [], features: {} } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => ({ output: response, estimatedCost: 0 })),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    complete: mock(async (_prompt: string) => response),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
  } as unknown as AgentAdapter;
}

function makeRunMockAgent(output: string, success = true): AgentAdapter {
  const agentResult: AgentResult = {
    success,
    exitCode: success ? 0 : 1,
    output,
    rateLimited: false,
    durationMs: 100,
    estimatedCost: 0,
  };
  return {
    name: "mock",
    displayName: "Mock Run Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: [],
      maxContextTokens: 128_000,
      features: new Set(),
    } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => agentResult),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("plan not used"); }),
    decompose: mock(async () => { throw new Error("decompose not used"); }),
    complete: mock(async (_prompt: string) => { throw new Error("complete() must NOT be called in non-debate path (US-003)"); }),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
  } as unknown as AgentAdapter;
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
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", "valid-sha", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

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
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

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
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", "stale-sha-after-rebase", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

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

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => null);

    expect(result.success).toBe(true);
    expect(result.output).toContain("skipped: no git ref");
  });

  test("skips review (success=true) when storyGitRef is invalid and merge-base is also unavailable", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);

    const result = await runSemanticReview("/tmp/wd", "bad-sha", STORY, DEFAULT_SEMANTIC_CONFIG, () => null);

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
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(agent.run).toHaveBeenCalled();
  });

  test("does NOT call agent.complete() for the non-debate path", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(agent.complete).not.toHaveBeenCalled();
  });

  test("agent.run() receives sessionRole='reviewer-semantic' and featureName for own session (#414)", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const workdir = "/my/project";
    const featureName = "my-feature";

    await runSemanticReview(workdir, "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent, undefined, featureName);

    expect(agent.run).toHaveBeenCalled();
    const runOpts = (agent.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(runOpts.sessionRole).toBe("reviewer-semantic");
    expect(runOpts.featureName).toBe(featureName);
    const expectedSession = computeAcpHandle(workdir, featureName, STORY.id, "reviewer-semantic");
    expect(expectedSession).toMatch(/^nax-[a-f0-9]+-my-feature-.+-reviewer-semantic$/);
  });

  test("agent.run() initial call uses keepOpen: true (session kept open for JSON retry)", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(agent.run).toHaveBeenCalled();
    const runOpts = (agent.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(runOpts.keepOpen).toBe(true);
  });

  test("session handle encodes workdir hash in session name (via computeAcpHandle)", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const workdirA = "/project/alpha";
    const workdirB = "/project/beta";
    const sessionA = computeAcpHandle(workdirA, "feat", STORY.id, "reviewer-semantic");
    const sessionB = computeAcpHandle(workdirB, "feat", STORY.id, "reviewer-semantic");

    await runSemanticReview(workdirA, "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent, undefined, "feat");
    const runOptsA = (agent.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;

    expect(sessionA).not.toBe(sessionB);
    expect(runOptsA.featureName).toBe("feat");
    expect(runOptsA.storyId).toBe(STORY.id);
  });

  test("session handle encodes featureName in session name (via computeAcpHandle)", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const featureName = "semantic-continuity";
    const expectedSession = computeAcpHandle("/tmp/wd", featureName, STORY.id, "reviewer-semantic");

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent, undefined, featureName);

    const runOpts = (agent.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(runOpts.featureName).toBe(featureName);
    expect(expectedSession).toContain("semantic-continuity");
  });

  test("session handle encodes storyId in session name (via computeAcpHandle)", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const storyWithDifferentId: SemanticStory = { ...STORY, id: "US-999" };
    const expectedSession = computeAcpHandle("/tmp/wd", "feat", "US-999", "reviewer-semantic");

    await runSemanticReview("/tmp/wd", "abc123", storyWithDifferentId, DEFAULT_SEMANTIC_CONFIG, () => agent, undefined, "feat");

    const runOpts = (agent.run as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(runOpts.storyId).toBe("US-999");
    expect(expectedSession).toContain("us-999");
  });

  test("extracts rawResponse from AgentRunResult.output field — passed=true", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(result.success).toBe(true);
    expect(result.output).toContain("Semantic review passed");
  });

  test("extracts rawResponse from AgentRunResult.output field — passed=false with findings", async () => {
    const agent = makeRunMockAgent(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Function is a stub");
  });

  test("ReviewCheckResult has check='semantic' field after run() path", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(result.check).toBe("semantic");
  });

  test("ReviewCheckResult has exitCode=0 when run() returns passed=true", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(result.exitCode).toBe(0);
  });

  test("ReviewCheckResult has exitCode=1 when run() returns passed=false", async () => {
    const agent = makeRunMockAgent(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(result.exitCode).toBe(1);
  });

  test("ReviewCheckResult has command='' field", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(result.command).toBe("");
  });

  test("ReviewCheckResult has durationMs field as number", async () => {
    const agent = makeRunMockAgent(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(typeof result.durationMs).toBe("number");
  });

  test("ReviewCheckResult includes findings when run() output has failing findings", async () => {
    const agent = makeRunMockAgent(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);
    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);
    expect((result.findings?.length ?? 0)).toBeGreaterThan(0);
  });
});
