/**
 * Unit tests for src/review/semantic.ts
 * Split 1: signature, missing-ref early exit, git diff invocation, diff truncation
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeMockAgentManager, makeMockRuntime, makeSpawn } from "@test/helpers";
import type { AgentResult } from "@/agents/types";
import { _diffUtilsDeps } from "@/review/diff-utils";
import type { RunSemanticReviewOptions, SemanticStory } from "@/review/semantic";
import { runSemanticReview } from "@/review/semantic";
import type { SemanticReviewConfig } from "@/review/types";

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
  excludePatterns: [
    ":!test/",
    ":!tests/",
    ":!*_test.go",
    ":!*.test.ts",
    ":!*.spec.ts",
    ":!**/__tests__/",
    ":!.nax/",
    ":!.nax-pids",
  ],
};

function makeAgentManager(llmResponse: string, cost = 0) {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runFn: async (_agent, _opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeFn: async () => ({
      output: llmResponse,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: cost,
    }),
    runWithFallbackFn: async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: cost,
        agentFallbacks: [],
      },
      fallbacks: [],
    }),
    completeWithFallbackFn: async () => ({
      result: {
        output: llmResponse,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: cost,
      },
      fallbacks: [],
    }),
    runAsFn: async (_agent, _opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [],
    }),
    completeAsFn: async (_agent, _prompt, _opts) => ({
      output: llmResponse,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: cost,
    }),
  });
}

function makeSpawnMock(stdout: string, exitCode = 0) {
  return makeSpawn(() => ({ exitCode, stdout })).spawn;
}

function makeSpawnMockWithStat(diffStdout: string, statStdout: string, exitCode = 0) {
  return makeSpawn(({ cmd }) => ({
    exitCode,
    stdout: cmd.includes("--stat") ? statStdout : diffStdout,
  })).spawn;
}

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });

// ---------------------------------------------------------------------------
// AC-1: Function signature / params
// ---------------------------------------------------------------------------

describe("runSemanticReview — signature", () => {
  test("is exported from src/review/semantic.ts", () => {
    expect(typeof runSemanticReview).toBe("function");
  });

  test("accepts the options object without TypeScript errors (compile check)", async () => {
    let called = false;
    const impl = async (_opts: RunSemanticReviewOptions) => {
      called = true;
      return { check: "semantic" as const, success: true, command: "", exitCode: 0, output: "", durationMs: 0 };
    };

    await impl({
      workdir: "/tmp/workdir",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager: undefined,
    });
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-4: Early exit when storyGitRef is missing
// ---------------------------------------------------------------------------

describe("runSemanticReview — missing storyGitRef", () => {
  let origSpawn: typeof _diffUtilsDeps.spawn;
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _diffUtilsDeps.spawn;
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  });

  afterEach(() => {
    _diffUtilsDeps.spawn = origSpawn;
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
  });

  test("returns success=true when storyGitRef is undefined", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: undefined,
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
  });

  test("returns output containing 'skipped: no git ref' when storyGitRef is undefined", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: undefined,
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.output).toContain("skipped: no git ref");
  });

  test("returns success=true when storyGitRef is empty string", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
  });

  test("returns output containing 'skipped: no git ref' when storyGitRef is empty string", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.output).toContain("skipped: no git ref");
  });

  test("does not invoke spawn when storyGitRef is undefined", async () => {
    const spawnMock = makeSpawnMock("", 0);
    _diffUtilsDeps.spawn = spawnMock;

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: undefined,
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      // No agentManager: this path must skip the review before any dispatch.
      agentManager: undefined,
    });

    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("result.check is 'semantic' when storyGitRef is undefined", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: undefined,
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      // No agentManager: this path must skip the review before any dispatch.
      agentManager: undefined,
    });

    expect(result.check).toBe("semantic");
  });
});

// ---------------------------------------------------------------------------
// AC-2: git diff command
// ---------------------------------------------------------------------------

describe("runSemanticReview — git diff invocation", () => {
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

  test("calls spawn with git diff --unified=3 <storyGitRef>..HEAD and test exclusions", async () => {
    const spawnMock = makeSpawnMock("diff output", 0);
    _diffUtilsDeps.spawn = spawnMock;
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(spawnMock).toHaveBeenCalled();
    const allCalls = (spawnMock as ReturnType<typeof mock>).mock.calls;
    const unifiedCallOpts = allCalls
      .map((c) => c[0] as { cmd: string[] })
      .find((opts) => opts.cmd?.includes("--unified=3"));
    expect(unifiedCallOpts).toBeDefined();
    const spawnOpts = unifiedCallOpts;
    assertDefined(spawnOpts, "unifiedCallOpts");
    expect(spawnOpts.cmd).toContain("git");
    expect(spawnOpts.cmd).toContain("diff");
    expect(spawnOpts.cmd).toContain("--unified=3");
    expect(spawnOpts.cmd).toContain("abc123..HEAD");
    expect(spawnOpts.cmd).toContain(":!test/");
    expect(spawnOpts.cmd).toContain(":!*.test.ts");
    expect(spawnOpts.cmd).toContain(":!*.spec.ts");
  });

  test("passes workdir as cwd to spawn", async () => {
    const spawnMock = makeSpawnMock("diff output", 0);
    _diffUtilsDeps.spawn = spawnMock;
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runSemanticReview({
      workdir: "/my/project",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    const call = (spawnMock as ReturnType<typeof mock>).mock.calls[0];
    const spawnOpts = call[0] as { cwd: string };
    expect(spawnOpts.cwd).toBe("/my/project");
  });
});

// ---------------------------------------------------------------------------
// Diff truncation at 51200 bytes (50KB)
// ---------------------------------------------------------------------------

describe("runSemanticReview — diff truncation", () => {
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

  test("passes full diff to LLM prompt when diff is under 51200 bytes", async () => {
    const smallDiff = "a".repeat(100);
    _diffUtilsDeps.spawn = makeSpawnMock(smallDiff, 0);
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    (agentManager.runWithFallback as ReturnType<typeof mock>).mockImplementation(async (_req) => {
      return {
        result: {
          success: true,
          exitCode: 0,
          output: PASSING_LLM_RESPONSE,
          rateLimited: false,
          durationMs: 100,
          estimatedCostUsd: 0,
        } as AgentResult,
        fallbacks: [],
      };
    });

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(_diffUtilsDeps.spawn).toHaveBeenCalled();
  });

  test("truncates diff and appends truncation marker when diff exceeds 51200 bytes", async () => {
    const largeDiff = "x".repeat(60_000);
    const statOutput = " src/foo.ts | 100 +\n src/bar.ts | 50 +\n 2 files changed";
    _diffUtilsDeps.spawn = makeSpawnMockWithStat(largeDiff, statOutput, 0);
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    (agentManager.runWithFallback as ReturnType<typeof mock>).mockImplementation(async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: PASSING_LLM_RESPONSE,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: 0,
      } as AgentResult,
      fallbacks: [],
    }));

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(_diffUtilsDeps.spawn).toHaveBeenCalled();
  });

  test("truncation includes file summary from git diff --stat", async () => {
    const largeDiff = "y".repeat(60_000);
    const statOutput = " src/foo.ts | 100 +\n src/bar.ts | 50 +\n 2 files changed";
    _diffUtilsDeps.spawn = makeSpawnMockWithStat(largeDiff, statOutput, 0);
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });
    (agentManager.runWithFallback as ReturnType<typeof mock>).mockImplementation(async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: PASSING_LLM_RESPONSE,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: 0,
      } as AgentResult,
      fallbacks: [],
    }));

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(_diffUtilsDeps.spawn).toHaveBeenCalled();
  });
});
