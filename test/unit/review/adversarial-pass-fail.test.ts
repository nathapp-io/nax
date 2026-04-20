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
import type { AgentAdapter } from "../../../src/agents/types";

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

function makeAgent(llmResponse: string, cost = 0.001): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: [],
      supportedTestStrategies: [],
      features: {},
    } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => ({ output: llmResponse, estimatedCost: cost })),
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
let origReadAcpSession: typeof _adversarialDeps.readAcpSession;
let origWriteReviewAudit: typeof _adversarialDeps.writeReviewAudit;

function saveAllDeps() {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origReadAcpSession = _adversarialDeps.readAcpSession;
  origWriteReviewAudit = _adversarialDeps.writeReviewAudit;
}

function restoreAllDeps() {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _adversarialDeps.readAcpSession = origReadAcpSession;
  _adversarialDeps.writeReviewAudit = origWriteReviewAudit;
}

function setupHappyPathDeps(statContent = STAT_OUTPUT) {
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = makeSpawnMock(statContent);
  _adversarialDeps.readAcpSession = mock(async () => null);
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
    const agent = makeAgent(PASSING_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
  });

  test("check field is 'adversarial'", async () => {
    const agent = makeAgent(PASSING_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
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
    const agent = makeAgent(FAILING_ERROR_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(false);
  });

  test("findings array is populated on failure", async () => {
    const agent = makeAgent(FAILING_ERROR_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
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
    const agent = makeAgent(FAILING_WARN_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
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
    const agent = makeAgent(UNVERIFIABLE_ONLY_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
  });

  test("returns success=true when all findings are info severity", async () => {
    const agent = makeAgent(INFO_ONLY_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
  });

  test("returns success=false when LLM says passed:true but includes error findings (findings take precedence)", async () => {
    const agent = makeAgent(PASSED_TRUE_WITH_ERROR_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
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
    _adversarialDeps.readAcpSession = mock(async () => null);
  });

  afterEach(restoreAllDeps);

  test("returns success=true when resolveEffectiveRef returns undefined", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd",
      undefined,
      STORY,
      ADVERSARIAL_CONFIG,
      () => makeAgent(PASSING_RESPONSE),
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when resolveEffectiveRef returns undefined", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd",
      undefined,
      STORY,
      ADVERSARIAL_CONFIG,
      () => makeAgent(PASSING_RESPONSE),
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
    _adversarialDeps.readAcpSession = mock(async () => null);
  });

  afterEach(restoreAllDeps);

  test("returns success=true when diff stat is empty", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => makeAgent(PASSING_RESPONSE),
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped: no changes detected' when stat is empty", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => makeAgent(PASSING_RESPONSE),
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
    const agent = makeAgent("this is not json at all");

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'fail-open' on garbage JSON", async () => {
    const agent = makeAgent("this is not json at all");

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
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
    const agent = makeAgent(truncatedResponse);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
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
      () => null,
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when modelResolver returns null", async () => {
    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => null,
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
    const throwingAgent = {
      ...makeAgent(PASSING_RESPONSE),
      run: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
    } as unknown as AgentAdapter;

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => throwingAgent,
    );

    expect(result.success).toBe(true);
  });

  test("output contains 'skipped' when agent.run() throws", async () => {
    const throwingAgent = {
      ...makeAgent(PASSING_RESPONSE),
      run: mock(async () => {
        throw new Error("LLM connection timeout");
      }),
    } as unknown as AgentAdapter;

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => throwingAgent,
    );

    expect(result.output).toContain("skipped");
  });
});
