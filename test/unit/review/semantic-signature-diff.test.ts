/**
 * Unit tests for src/review/semantic.ts
 * Split 1: signature, missing-ref early exit, git diff invocation, diff truncation
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
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

function makeSpawnMockWithStat(diffStdout: string, statStdout: string, exitCode = 0) {
  return mock((opts: { cmd?: string[] }) => {
    const isStatCall = opts.cmd?.includes("--stat");
    const stdout = isStatCall ? statStdout : diffStdout;
    return {
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
    };
  }) as unknown as typeof _diffUtilsDeps.spawn;
}

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });

// ---------------------------------------------------------------------------
// AC-1: Function signature / params
// ---------------------------------------------------------------------------

describe("runSemanticReview — signature", () => {
  test("is exported from src/review/semantic.ts", () => {
    expect(typeof runSemanticReview).toBe("function");
  });

  test("accepts five parameters without TypeScript errors (compile check)", async () => {
    let called = false;
    const impl = async (..._args: Parameters<typeof runSemanticReview>) => {
      called = true;
      return { check: "semantic" as const, success: true, command: "", exitCode: 0, output: "", durationMs: 0 };
    };

    await impl("/tmp/workdir", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => null);
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
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });

  test("returns output containing 'skipped: no git ref' when storyGitRef is undefined", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("skipped: no git ref");
  });

  test("returns success=true when storyGitRef is empty string", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.success).toBe(true);
  });

  test("returns output containing 'skipped: no git ref' when storyGitRef is empty string", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    const result = await runSemanticReview("/tmp/wd", "", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(result.output).toContain("skipped: no git ref");
  });

  test("does not invoke spawn when storyGitRef is undefined", async () => {
    const spawnMock = makeSpawnMock("", 0);
    _diffUtilsDeps.spawn = spawnMock;

    await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => null);

    expect(spawnMock).not.toHaveBeenCalled();
  });

  test("result.check is 'semantic' when storyGitRef is undefined", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("", 0);

    const result = await runSemanticReview("/tmp/wd", undefined, STORY, DEFAULT_SEMANTIC_CONFIG, () => null);

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
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(spawnMock).toHaveBeenCalled();
    const allCalls = (spawnMock as ReturnType<typeof mock>).mock.calls;
    const unifiedCallOpts = allCalls.map((c) => c[0] as { cmd: string[] })
      .find((opts) => opts.cmd?.includes("--unified=3"));
    expect(unifiedCallOpts).toBeDefined();
    const spawnOpts = unifiedCallOpts!;
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
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);

    await runSemanticReview("/my/project", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

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
    let capturedPrompt = "";
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);
    (agent.run as ReturnType<typeof mock>).mockImplementation(async (args: { prompt: string }) => {
      capturedPrompt = args.prompt;
      return { output: PASSING_LLM_RESPONSE, estimatedCost: 0 };
    });

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(capturedPrompt).toContain(smallDiff);
  });

  test("truncates diff and appends truncation marker when diff exceeds 51200 bytes", async () => {
    const largeDiff = "x".repeat(60_000);
    const statOutput = " src/foo.ts | 100 +\n src/bar.ts | 50 +\n 2 files changed";
    _diffUtilsDeps.spawn = makeSpawnMockWithStat(largeDiff, statOutput, 0);
    let capturedPrompt = "";
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);
    (agent.run as ReturnType<typeof mock>).mockImplementation(async (args: { prompt: string }) => {
      capturedPrompt = args.prompt;
      return { output: PASSING_LLM_RESPONSE, estimatedCost: 0 };
    });

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(capturedPrompt).toContain("truncated at 51200 bytes");
    const diffSection = capturedPrompt.match(/```diff\n([\s\S]*?)```/)?.[1] ?? "";
    expect(diffSection.length).toBeLessThanOrEqual(51_200 + 500);
  });

  test("truncation includes file summary from git diff --stat", async () => {
    const largeDiff = "y".repeat(60_000);
    const statOutput = " src/foo.ts | 100 +\n src/bar.ts | 50 +\n 2 files changed";
    _diffUtilsDeps.spawn = makeSpawnMockWithStat(largeDiff, statOutput, 0);
    let capturedPrompt = "";
    const agent = makeMockAgent(PASSING_LLM_RESPONSE);
    (agent.run as ReturnType<typeof mock>).mockImplementation(async (args: { prompt: string }) => {
      capturedPrompt = args.prompt;
      return { output: PASSING_LLM_RESPONSE, estimatedCost: 0 };
    });

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(capturedPrompt).toContain("File Summary (all changed files)");
    expect(capturedPrompt).toContain("src/foo.ts");
    expect(capturedPrompt).toContain("src/bar.ts");
  });
});
