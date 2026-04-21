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
  modelTier: "balanced",
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
    plan: mock(async () => {
      throw new Error("not used");
    }),
    decompose: mock(async () => {
      throw new Error("not used");
    }),
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
    events: {
      on: () => {},
      off: () => {},
    },
    resolveFallbackChain: (_agent: string, _failure: unknown) => [],
    shouldSwap: (_failure: unknown, _hops: number, _bundle: unknown) => false,
    nextCandidate: (_current: string, _hops: number) => null,
    runWithFallback: mock(async () => ({ result: { success: true, exitCode: 0, output: llmResponse, rateLimited: false, durationMs: 100, estimatedCost: cost }, fallbacks: [] })),
    completeWithFallback: mock(async () => ({ result: { output: llmResponse, costUsd: cost, source: "mock" }, fallbacks: [] })),
    run: mock(async (request: { runOptions: unknown }) => {
      const opts = request.runOptions as { prompt?: string };
      void opts;
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
      const opts = request.runOptions as { prompt?: string };
      void opts;
      return {
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCost: cost,
      } as AgentResult;
    }),
    plan: mock(async () => {
      throw new Error("not used");
    }),
    planAs: mock(async () => {
      throw new Error("not used");
    }),
    decompose: mock(async () => {
      throw new Error("not used");
    }),
    decomposeAs: mock(async () => {
      throw new Error("not used");
    }),
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
    const agentManager = makeAgentManager(PASSING_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

    expect(result.success).toBe(true);
  });

  test("check field is 'adversarial'", async () => {
    const agentManager = makeAgentManager(PASSING_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

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
    const agentManager = makeAgentManager(FAILING_ERROR_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

    expect(result.success).toBe(false);
  });

  test("findings array is populated on failure", async () => {
    const agentManager = makeAgentManager(FAILING_ERROR_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

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
    const agentManager = makeAgentManager(FAILING_WARN_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

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
    const agentManager = makeAgentManager(UNVERIFIABLE_ONLY_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

    expect(result.success).toBe(true);
  });

  test("returns success=true when all findings are info severity", async () => {
    const agentManager = makeAgentManager(INFO_ONLY_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

    expect(result.success).toBe(true);
  });

  test("returns success=false when LLM says passed:true but includes error findings (findings take precedence)", async () => {
    const agentManager = makeAgentManager(PASSED_TRUE_WITH_ERROR_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

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
    const result = await runAdversarialReview(
      "/tmp/wd",
      undefined,
      STORY,
      ADVERSARIAL_CONFIG,
      makeAgentManager(PASSING_RESPONSE),
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when resolveEffectiveRef returns undefined", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd",
      undefined,
      STORY,
      ADVERSARIAL_CONFIG,
      makeAgentManager(PASSING_RESPONSE),
    );

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
    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      makeAgentManager(PASSING_RESPONSE),
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped: no changes detected' when stat is empty", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      makeAgentManager(PASSING_RESPONSE),
    );

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
    const agentManager = makeAgentManager("this is not json at all");

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'fail-open' on garbage JSON", async () => {
    const agentManager = makeAgentManager("this is not json at all");

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

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
    const agentManager = makeAgentManager(truncatedResponse);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      agentManager,
    );

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
    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      undefined,
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when modelResolver returns null", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      undefined,
    );

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
    const throwingAdapter: AgentAdapter = {
      name: "mock",
      displayName: "Mock Agent",
      binary: "mock",
      capabilities: {
        supportedTiers: [],
        supportedTestStrategies: [],
        features: {},
      } as unknown as AgentAdapter["capabilities"],
      isInstalled: mock(async () => true),
      run: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      buildCommand: mock(() => []),
      plan: mock(async () => {
        throw new Error("not used");
      }),
      decompose: mock(async () => {
        throw new Error("not used");
      }),
      complete: mock(async (_prompt: string) => {
        throw new Error("LLM connection timeout");
      }),
      closeSession: mock(async () => {}),
      closePhysicalSession: mock(async () => {}),
    } as unknown as AgentAdapter;

    const throwingManager = {
      getDefault: () => "claude",
      getAgent: (_name: string) => throwingAdapter,
      isUnavailable: (_agent: string) => false,
      markUnavailable: (_agent: string, _reason: unknown) => {},
      reset: () => {},
      validateCredentials: mock(async () => {}),
      events: { on: () => {}, off: () => {} },
      resolveFallbackChain: (_agent: string, _failure: unknown) => [],
      shouldSwap: (_failure: unknown, _hops: number, _bundle: unknown) => false,
      nextCandidate: (_current: string, _hops: number) => null,
      runWithFallback: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      completeWithFallback: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      run: mock(async (_request: { runOptions: unknown }) => {
        throw new Error("LLM connection timeout");
      }),
      complete: mock(async (_prompt: string) => {
        throw new Error("LLM connection timeout");
      }),
      completeAs: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      runAs: mock(async (_agent: string, request: { runOptions: unknown }) => {
        void request;
        throw new Error("LLM connection timeout");
      }),
      plan: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      planAs: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      decompose: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      decomposeAs: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
    } as unknown as IAgentManager;

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      throwingManager,
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when agent.run() throws", async () => {
    const throwingAdapter: AgentAdapter = {
      name: "mock",
      displayName: "Mock Agent",
      binary: "mock",
      capabilities: {
        supportedTiers: [],
        supportedTestStrategies: [],
        features: {},
      } as unknown as AgentAdapter["capabilities"],
      isInstalled: mock(async () => true),
      run: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      buildCommand: mock(() => []),
      plan: mock(async () => {
        throw new Error("not used");
      }),
      decompose: mock(async () => {
        throw new Error("not used");
      }),
      complete: mock(async (_prompt: string) => {
        throw new Error("LLM connection timeout");
      }),
      closeSession: mock(async () => {}),
      closePhysicalSession: mock(async () => {}),
    } as unknown as AgentAdapter;

    const throwingManager = {
      getDefault: () => "claude",
      getAgent: (_name: string) => throwingAdapter,
      isUnavailable: (_agent: string) => false,
      markUnavailable: (_agent: string, _reason: unknown) => {},
      reset: () => {},
      validateCredentials: mock(async () => {}),
      events: { on: () => {}, off: () => {} },
      resolveFallbackChain: (_agent: string, _failure: unknown) => [],
      shouldSwap: (_failure: unknown, _hops: number, _bundle: unknown) => false,
      nextCandidate: (_current: string, _hops: number) => null,
      runWithFallback: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      completeWithFallback: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      run: mock(async (_request: { runOptions: unknown }) => {
        throw new Error("LLM connection timeout");
      }),
      complete: mock(async (_prompt: string) => {
        throw new Error("LLM connection timeout");
      }),
      completeAs: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      runAs: mock(async (_agent: string, request: { runOptions: unknown }) => {
        void request;
        throw new Error("LLM connection timeout");
      }),
      plan: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      planAs: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      decompose: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
      decomposeAs: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
    } as unknown as IAgentManager;

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      throwingManager,
    );

    expect(result.output).toContain("skipped");
  });
});
