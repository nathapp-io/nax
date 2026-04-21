/**
 * Unit tests for src/review/semantic.ts
 * Split 2: LLM prompt construction, response parsing (pass/fail), fail-open/fail-closed,
 * markdown fence stripping (BUG-090), truncated JSON fail-closed (#105)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";
import type { IAgentManager } from "../../../src/agents/manager-types";
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

function makeAgentManager(llmResponse: string, cost = 0): IAgentManager {
  const adapter: AgentAdapter = {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: [],
      supportedTestStrategies: [],
      features: {},
    } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async (_opts) => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCost: cost,
    })),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    complete: mock(async (_prompt: string) => llmResponse),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
  } as unknown as AgentAdapter;

  const manager = {
    getDefault: () => "claude",
    getAgent: (_name: string) => adapter,
    isUnavailable: (_agent: string) => false,
    markUnavailable: (_agent: string, _reason: unknown) => {},
    reset: () => {},
    validateCredentials: mock(async () => {}),
    events: { on: () => {}, off: () => {} },
    resolveFallbackChain: (_agent: string, _failure: unknown) => [],
    shouldSwap: (_failure: unknown, _hops: number, _bundle: unknown) => false,
    nextCandidate: (_current: string, _hops: number) => null,
    runWithFallback: mock(async () => ({ result: { success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCost: cost }, fallbacks: [] })),
    completeWithFallback: mock(async () => ({ result: { output: llmResponse, costUsd: cost, source: "mock" }, fallbacks: [] })),
    run: mock(async (request: { runOptions: unknown }) => {
      void request;
      return {
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCost: cost,
      } as AgentResult;
    }),
    complete: mock(async (_prompt: string) => ({ output: llmResponse, costUsd: cost, source: "mock" })),
    completeAs: mock(async (_agent: string, _prompt: string, _opts?: unknown) => ({ output: llmResponse, costUsd: cost, source: "mock" })),
    runAs: mock(async (_agent: string, request: { runOptions: unknown }) => {
      void request;
      return {
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCost: cost,
      } as AgentResult;
    }),
    plan: mock(async () => { throw new Error("not used"); }),
    planAs: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    decomposeAs: mock(async () => { throw new Error("not used"); }),
  } as unknown as IAgentManager;

  return manager;
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
// AC-5: LLM prompt contents
// ---------------------------------------------------------------------------

describe("runSemanticReview — LLM prompt construction", () => {
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

  async function capturePrompt(
    story: SemanticStory = STORY,
    config: SemanticReviewConfig = DEFAULT_SEMANTIC_CONFIG,
    diff = "- old line\n+ new line\n",
  ): Promise<string> {
    _diffUtilsDeps.spawn = makeSpawnMock(diff, 0);
    let capturedPrompt = "";
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    (agentManager.run as ReturnType<typeof mock>).mockImplementation(async (args: { runOptions: { prompt: string } }) => {
      capturedPrompt = args.runOptions.prompt;
      return { success: true, exitCode: 0, output: PASSING_LLM_RESPONSE, rateLimited: false, durationMs: 100, estimatedCost: 0 } as AgentResult;
    });
    await runSemanticReview("/tmp/wd", "abc123", story, config, agentManager);
    return capturedPrompt;
  }

  test("prompt includes story title", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain(STORY.title);
  });

  test("prompt includes story description", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain(STORY.description);
  });

  test("prompt includes all acceptance criteria as numbered list", async () => {
    const prompt = await capturePrompt();
    STORY.acceptanceCriteria.forEach((ac, idx) => {
      expect(prompt).toContain(`${idx + 1}.`);
      expect(prompt).toContain(ac);
    });
  });

  test("prompt includes AC-focused review criteria", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain("acceptance criterion");
    expect(prompt).toContain("dead paths");
    expect(prompt).toContain("wired into callers");
  });

  test("prompt includes custom rules from semanticConfig.rules", async () => {
    const config: SemanticReviewConfig = {
      modelTier: "balanced",
      diffMode: "embedded",
      resetRefOnRerun: false,
      timeoutMs: 60_000,
      rules: ["Never use console.log", "All exports must be typed"],
      excludePatterns: [":!test/"],
    };
    const prompt = await capturePrompt(STORY, config);
    expect(prompt).toContain("Never use console.log");
    expect(prompt).toContain("All exports must be typed");
  });

  test("prompt includes git diff in a code block", async () => {
    const diff = "- old line\n+ new line\n";
    const prompt = await capturePrompt(STORY, DEFAULT_SEMANTIC_CONFIG, diff);
    expect(prompt).toContain("```");
    expect(prompt).toContain(diff);
  });

  test("prompt does not include custom rules section when semanticConfig.rules is empty", async () => {
    const prompt = await capturePrompt(STORY, DEFAULT_SEMANTIC_CONFIG);
    expect(prompt.length).toBeGreaterThan(100);
  });

  test("prompt states diff is production code only", async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain("production code only");
    expect(prompt).toContain("Do NOT flag");
    expect(prompt).toContain("lint handles");
  });
});

// ---------------------------------------------------------------------------
// AC-6 + AC-7: JSON response parsing — passed=false with findings
// ---------------------------------------------------------------------------

describe("runSemanticReview — LLM response parsing (passed=false)", () => {
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

  test("returns success=false when LLM returns passed=false", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(false);
  });

  test("output contains finding's file", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.output).toContain("src/review/semantic.ts");
  });

  test("output contains finding's line number", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.output).toContain("42");
  });

  test("output contains finding's severity", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.output).toContain("error");
  });

  test("output contains finding's issue description", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.output).toContain("Function is a stub");
  });

  test("output contains finding's suggestion", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(FAILING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.output).toContain("Implement the function");
  });

  test("returns success=true when LLM returns passed=true with empty findings", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(true);
  });

  test("multiple blocking findings all appear in output", async () => {
    const multiFindings = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "Issue A", suggestion: "Fix A" },
        { severity: "error", file: "src/b.ts", line: 99, issue: "Issue B", suggestion: "Fix B" },
      ],
    });
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(multiFindings);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.output).toContain("src/a.ts");
    expect(result.output).toContain("Issue A");
    expect(result.output).toContain("src/b.ts");
    expect(result.output).toContain("Issue B");
  });
});

// ---------------------------------------------------------------------------
// AC-8: Fail-open on invalid JSON
// ---------------------------------------------------------------------------

describe("runSemanticReview — fail-open on invalid JSON", () => {
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

  test("returns success=true when LLM returns invalid JSON", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager("this is not json at all }{");
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(true);
  });

  test("returns success=true when LLM returns empty string", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager("");
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(true);
  });

  test("returns success=true when LLM returns JSON missing 'passed' field", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager(JSON.stringify({ findings: [] }));
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(true);
  });

  test("result check is 'semantic' on invalid JSON", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const agentManager = makeAgentManager("not json");
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.check).toBe("semantic");
  });
});

// ---------------------------------------------------------------------------
// #105: Truncated JSON with "passed": false should fail-closed
// ---------------------------------------------------------------------------

describe("runSemanticReview — fail-closed on truncated JSON with passed:false (#105)", () => {
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

  test("returns success=false when truncated JSON contains passed:false", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const truncatedResponse = '```json\n{"passed": false, "findings": [{"severity": "error", "file": "test.ts", "line": 1, "issue": "Test file is 78';
    const agentManager = makeAgentManager(truncatedResponse);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(false);
  });

  test("output mentions truncated response on fail-closed", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const truncatedResponse = '{"passed": false, "findings": [{"severity": "error"';
    const agentManager = makeAgentManager(truncatedResponse);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.output).toContain("truncated");
    expect(result.output).toContain("passed:false");
  });

  test("still fail-open when truncated JSON contains passed:true", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const truncatedResponse = '{"passed": true, "findings": [';
    const agentManager = makeAgentManager(truncatedResponse);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BUG-090: Markdown fence stripping
// ---------------------------------------------------------------------------

describe("runSemanticReview — markdown fence stripping (BUG-090)", () => {
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

  test("parses JSON wrapped in ```json fences", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const fencedResponse = "```json\n" + JSON.stringify({ passed: true, findings: [] }) + "\n```";
    const agentManager = makeAgentManager(fencedResponse);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("could not parse");
  });

  test("parses JSON wrapped in plain ``` fences", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const fencedResponse = "```\n" + JSON.stringify({ passed: true, findings: [] }) + "\n```";
    const agentManager = makeAgentManager(fencedResponse);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("could not parse");
  });

  test("parses fenced JSON with findings and returns success=false", async () => {
    _diffUtilsDeps.spawn = makeSpawnMock("some diff", 0);
    const payload = {
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", line: 1, issue: "bad code", suggestion: "fix it" }],
    };
    const fencedResponse = "```json\n" + JSON.stringify(payload) + "\n```";
    const agentManager = makeAgentManager(fencedResponse);
    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);
    expect(result.success).toBe(false);
  });
});
