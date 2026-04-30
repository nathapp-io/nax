/**
 * Unit tests for src/review/adversarial.ts
 *
 * Covers: pass, fail (error/warn), non-blocking overrides, skip conditions
 * (no ref, no stat, no agent), fail-open/fail-closed on JSON parse issues,
 * fail-open on LLM error.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _adversarialDeps, runAdversarialReview } from "../../../src/review/adversarial";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import type { AdversarialReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";
import type { AgentAdapter, AgentResult } from "../../../src/agents/types";
import type { IAgentManager } from "../../../src/agents/manager-types";
import { makeAgentAdapter, makeMockAgentManager, makeMockRuntime } from "../../helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "STORY-001",
  title: "Add auth",
  description: "Auth feature",
  acceptanceCriteria: ["Users can log in"],
};

const ADVERSARIAL_CONFIG: AdversarialReviewConfig = {
  model: "balanced",
  diffMode: "ref",
  rules: [],
  timeoutMs: 180_000,
  excludePatterns: [],
  parallel: false,
  maxConcurrentSessions: 2,
};

const STAT_OUTPUT = "src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentManager(llmResponse: string, cost = 0.001): IAgentManager {
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
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: cost,
        agentFallbacks: [] as unknown[],
      };
      return { result, fallbacks: [], bundle: request.bundle };
    },
    completeWithFallbackFn: async () => ({ result: { output: llmResponse, costUsd: cost, source: "mock" }, fallbacks: [] }),
    runAsFn: async () => ({
      success: true,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [] as unknown[],
    }),
    completeAsFn: async () => ({ output: llmResponse, costUsd: cost, source: "mock" }),
    getAgentFn: () => makeAgentAdapter(),
  });
}

function makeRuntime(agentManager: IAgentManager) {
  return makeMockRuntime({ agentManager });
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

const PASSING_RESPONSE = JSON.stringify({ passed: true, findings: [] });

const FAILING_ERROR_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      category: "error-path",
      file: "src/auth.ts",
      line: 10,
      issue: "No error handling on login",
      suggestion: "Add try/catch",
    },
  ],
});

const FAILING_WARN_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "warn",
      category: "abandonment",
      file: "src/auth.ts",
      line: 20,
      issue: "Token never invalidated on logout",
      suggestion: "Call revokeToken()",
    },
  ],
});

const UNVERIFIABLE_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "unverifiable",
      category: "input",
      file: "src/auth.ts",
      line: 5,
      issue: "Cannot verify external service behaviour",
      suggestion: "N/A",
    },
  ],
});

const INFO_ONLY_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "info",
      category: "convention",
      file: "src/auth.ts",
      line: 8,
      issue: "Could add more inline comments",
      suggestion: "Add JSDoc",
    },
  ],
});

const PASSED_TRUE_WITH_ERROR_RESPONSE = JSON.stringify({
  passed: true,
  findings: [
    {
      severity: "error",
      category: "error-path",
      file: "src/auth.ts",
      line: 15,
      issue: "Unhandled promise rejection",
      suggestion: "Add .catch()",
    },
  ],
});

// ---------------------------------------------------------------------------
// Shared saved deps
// ---------------------------------------------------------------------------

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
let origWriteReviewAudit: typeof _adversarialDeps.writeReviewAudit;

function saveAllDeps() {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _adversarialDeps.writeReviewAudit;
}

function restoreAllDeps() {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _adversarialDeps.writeReviewAudit = origWriteReviewAudit;
}

function setupHappyPathDeps(statContent = STAT_OUTPUT) {
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = makeSpawnMock(statContent);
}

async function callRunAdversarialReview(llmResponse: string): Promise<import("../../../src/review/types").ReviewCheckResult> {
  const agentManager = makeAgentManager(llmResponse);
  const runtime = makeMockRuntime({ agentManager });
  return runAdversarialReview({
    workdir: "/tmp/wd",
    storyGitRef: "abc123",
    story: STORY,
    adversarialConfig: ADVERSARIAL_CONFIG,
    agentManager,
    runtime,
  });
}

// ---------------------------------------------------------------------------
// AC-1: Pass — LLM returns passed:true with no findings
// ---------------------------------------------------------------------------

describe("runAdversarialReview — pass", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success=true when LLM returns passed:true", async () => {
    const result = await callRunAdversarialReview(PASSING_RESPONSE);
    expect(result.success).toBe(true);
  });

  test("check field is 'adversarial'", async () => {
    const result = await callRunAdversarialReview(PASSING_RESPONSE);
    expect(result.check).toBe("adversarial");
  });
});

// ---------------------------------------------------------------------------
// AC-2: Fail with error finding
// ---------------------------------------------------------------------------

describe("runAdversarialReview — fail with error finding", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success=false when LLM returns findings with severity 'error'", async () => {
    const result = await callRunAdversarialReview(FAILING_ERROR_RESPONSE);
    expect(result.success).toBe(false);
  });

  test("findings array is populated on failure", async () => {
    const result = await callRunAdversarialReview(FAILING_ERROR_RESPONSE);
    expect(result.findings).toBeDefined();
    expect(result.findings!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-3: Fail with warn finding
// ---------------------------------------------------------------------------

describe("runAdversarialReview — fail with warn finding", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success=true with advisory findings when LLM returns 'warn' severity (advisory at default threshold)", async () => {
    const result = await callRunAdversarialReview(FAILING_WARN_RESPONSE);
    expect(result.success).toBe(true);
    expect(result.advisoryFindings).toBeDefined();
    expect(result.advisoryFindings![0].message).toBe("Token never invalidated on logout");
  });
});

// ---------------------------------------------------------------------------
// AC-4: Non-blocking only (unverifiable) → override to pass
// ---------------------------------------------------------------------------

describe("runAdversarialReview — non-blocking only findings", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success=true when all findings are unverifiable", async () => {
    const result = await callRunAdversarialReview(UNVERIFIABLE_ONLY_RESPONSE);
    expect(result.success).toBe(true);
  });

  test("returns success=true when all findings are info severity", async () => {
    const result = await callRunAdversarialReview(INFO_ONLY_RESPONSE);
    expect(result.success).toBe(true);
  });

  test("returns success=false when LLM says passed:true but includes error findings (findings take precedence)", async () => {
    const result = await callRunAdversarialReview(PASSED_TRUE_WITH_ERROR_RESPONSE);
    expect(result.success).toBe(false);
    expect(result.findings).toBeDefined();
    expect(result.findings!.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// AC-5: Skip when no git ref
// ---------------------------------------------------------------------------

describe("runAdversarialReview — skip on no git ref", () => {
  beforeEach(() => {
    saveAllDeps();
    _diffUtilsDeps.isGitRefValid = mock(async () => false);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    _diffUtilsDeps.spawn = makeSpawnMock("");
  });

  afterEach(restoreAllDeps);

  test("returns success=true when resolveEffectiveRef returns undefined", async () => {
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: undefined,
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: makeAgentManager(PASSING_RESPONSE),
    });

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when resolveEffectiveRef returns undefined", async () => {
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: undefined,
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: makeAgentManager(PASSING_RESPONSE),
    });

    expect(result.output).toContain("skipped");
  });
});

// ---------------------------------------------------------------------------
// AC-6: Skip when stat is empty
// ---------------------------------------------------------------------------

describe("runAdversarialReview — skip when no stat", () => {
  beforeEach(() => {
    saveAllDeps();
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    _diffUtilsDeps.spawn = makeSpawnMock("");
  });

  afterEach(restoreAllDeps);

  test("returns success=true when diff stat is empty", async () => {
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: makeAgentManager(PASSING_RESPONSE),
    });

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped: no changes detected' when stat is empty", async () => {
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: makeAgentManager(PASSING_RESPONSE),
    });

    expect(result.output).toContain("skipped: no changes detected");
  });
});

// ---------------------------------------------------------------------------
// AC-7: Fail-open on invalid JSON
// ---------------------------------------------------------------------------

describe("runAdversarialReview — fail-open on unparseable JSON", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success=true when LLM returns garbage JSON with no passed:false signal", async () => {
    const result = await callRunAdversarialReview("this is not json at all");
    expect(result.success).toBe(true);
  });

  test("output contains 'fail-open' on garbage JSON", async () => {
    const result = await callRunAdversarialReview("this is not json at all");
    expect(result.output).toContain("fail-open");
  });
});

// ---------------------------------------------------------------------------
// AC-8: Fail-closed on truncated JSON containing "passed": false
// ---------------------------------------------------------------------------

describe("runAdversarialReview — fail-closed on truncated JSON with passed:false", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success=false when raw response has passed:false but is malformed JSON", async () => {
    const truncatedResponse = '{ "passed": false, "findings": [{ "severity": "error"';
    const result = await callRunAdversarialReview(truncatedResponse);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-9: Fail-open when no agent
// ---------------------------------------------------------------------------

describe("runAdversarialReview — fail-open when modelResolver returns null", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

test("returns success=true when modelResolver returns null", async () => {
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: undefined,
    });

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when modelResolver returns null", async () => {
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: undefined,
    });

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when modelResolver returns null", async () => {
    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: undefined,
    });

    expect(result.output).toContain("skipped");
  });
});

// ---------------------------------------------------------------------------
// AC-10: Fail-open on LLM error
// ---------------------------------------------------------------------------

describe("runAdversarialReview — fail-open on LLM error", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success=true when agent.run() throws", async () => {
    const throwingManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runFn: async () => {
        throw new Error("LLM connection timeout");
      },
      completeFn: async () => {
        throw new Error("LLM connection timeout");
      },
      runWithFallbackFn: async () => {
        throw new Error("LLM connection timeout");
      },
    });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: throwingManager,
      runtime: makeRuntime(throwingManager),
    });

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when agent.run() throws", async () => {
    const throwingManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      runFn: async () => {
        throw new Error("LLM connection timeout");
      },
      completeFn: async () => {
        throw new Error("LLM connection timeout");
      },
      runWithFallbackFn: async () => {
        throw new Error("LLM connection timeout");
      },
    });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager: throwingManager,
      runtime: makeRuntime(throwingManager),
    });

    expect(result.output).toContain("skipped");
  });
});
