/**
 * Unit tests — runSemanticReview debate integration (US-004)
 *
 * AC3: When debate.enabled=true and stages.review.enabled=true,
 *      runSemanticReview() uses DebateSession.run() instead of agent.complete()
 * AC4: When majority resolver used, ReviewCheckResult.success reflects majority vote
 * AC5: When majority resolver used, findings are merged and deduplicated across debaters
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentAdapter } from "../../../src/agents/types";
import type { NaxConfig } from "../../../src/config";
import type { DebateResult } from "../../../src/debate/types";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "US-004",
  title: "Integrate debate into semantic review",
  description: "Wire DebateSession into runSemanticReview()",
  acceptanceCriteria: [
    "When debate enabled for review, DebateSession.run() is called",
    "Majority vote determines ReviewCheckResult.success",
  ],
};

const SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 30000,
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const DEBATE_REVIEW_ENABLED_CONFIG: NaxConfig = {
  debate: {
    enabled: true,
    agents: 2,
    stages: {
      plan: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      review: {
        enabled: true,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
        debaters: [
          { agent: "claude" },
          { agent: "opencode" },
          { agent: "gemini" },
        ],
      },
      acceptance: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      rectification: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      escalation: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    },
  },
} as NaxConfig;

/** Proposal output for a passing LLM review */
const PROPOSAL_PASS = JSON.stringify({ passed: true, findings: [] });

/** Proposal output for a failing LLM review */
const PROPOSAL_FAIL_A = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      file: "src/review/semantic.ts",
      line: 10,
      issue: "AC1 not implemented",
      suggestion: "Implement debate branch",
    },
  ],
});

/** Proposal with a different finding (different file/line) */
const PROPOSAL_FAIL_B = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      file: "src/review/semantic.ts",
      line: 10,
      issue: "AC1 not implemented",
      suggestion: "Implement debate branch",
    },
    {
      severity: "warn",
      file: "src/cli/plan.ts",
      line: 200,
      issue: "Missing debate call",
      suggestion: "Wire DebateSession",
    },
  ],
});

/** DebateResult with majority passing (2 pass, 1 fail) */
const DEBATE_MAJORITY_PASS_RESULT: DebateResult = {
  storyId: "US-004",
  stage: "review",
  outcome: "passed",
  rounds: 1,
  debaters: ["claude", "opencode", "gemini"],
  resolverType: "majority-fail-closed",
  proposals: [
    { debater: { agent: "claude" }, output: PROPOSAL_PASS },
    { debater: { agent: "opencode" }, output: PROPOSAL_PASS },
    { debater: { agent: "gemini" }, output: PROPOSAL_FAIL_A },
  ],
  totalCostUsd: 0.002,
};

/** DebateResult with majority failing (1 pass, 2 fail) */
const DEBATE_MAJORITY_FAIL_RESULT: DebateResult = {
  storyId: "US-004",
  stage: "review",
  outcome: "failed",
  rounds: 1,
  debaters: ["claude", "opencode", "gemini"],
  resolverType: "majority-fail-closed",
  proposals: [
    { debater: { agent: "claude" }, output: PROPOSAL_PASS },
    { debater: { agent: "opencode" }, output: PROPOSAL_FAIL_A },
    { debater: { agent: "gemini" }, output: PROPOSAL_FAIL_A },
  ],
  totalCostUsd: 0.002,
};

/** DebateResult with duplicate findings across debaters */
const DEBATE_DUPLICATE_FINDINGS_RESULT: DebateResult = {
  storyId: "US-004",
  stage: "review",
  outcome: "failed",
  rounds: 1,
  debaters: ["claude", "opencode"],
  resolverType: "majority-fail-closed",
  proposals: [
    { debater: { agent: "claude" }, output: PROPOSAL_FAIL_A },
    { debater: { agent: "opencode" }, output: PROPOSAL_FAIL_B },
  ],
  totalCostUsd: 0.001,
};

// ─────────────────────────────────────────────────────────────────────────────
// Save originals
// ─────────────────────────────────────────────────────────────────────────────

const origSpawn = _semanticDeps.spawn;
const origIsGitRefValid = _semanticDeps.isGitRefValid;
const origGetMergeBase = _semanticDeps.getMergeBase;
const origCreateDebateSession = _semanticDeps.createDebateSession;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeSpawnMock(stdout = "", exitCode = 0) {
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
  })) as unknown as typeof _semanticDeps.spawn;
}

function makeMockAgent(response: string): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock",
    binary: "mock",
    capabilities: {} as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => ({ output: response, estimatedCost: 0 })),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    complete: mock(async () => response),
  } as unknown as AgentAdapter;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("runSemanticReview — debate integration (US-004)", () => {
  const WORKDIR = "/tmp/test-workdir";
  const STORY_GIT_REF = "abc123";

  beforeEach(() => {
    _semanticDeps.spawn = makeSpawnMock("diff content");
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => null);
    _semanticDeps.createDebateSession = origCreateDebateSession;
  });

  afterEach(() => {
    mock.restore();
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
    _semanticDeps.createDebateSession = origCreateDebateSession;
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC3: debate enabled → DebateSession.run() used instead of agent.complete()
  // ─────────────────────────────────────────────────────────────────────────

  test("AC3: createDebateSession is called when debate.stages.review.enabled=true", async () => {
    const runMock = mock(async () => DEBATE_MAJORITY_PASS_RESULT);
    _semanticDeps.createDebateSession = mock(() => ({ run: runMock }));

    const agentCompleteMock = mock(async () => PROPOSAL_PASS);
    const mockAgent = makeMockAgent(PROPOSAL_PASS);
    (mockAgent.complete as ReturnType<typeof mock>) = agentCompleteMock;

    await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => mockAgent,
      DEBATE_REVIEW_ENABLED_CONFIG,
    );

    expect(_semanticDeps.createDebateSession).toHaveBeenCalled();
  });

  test("AC3: DebateSession.run() is called with the semantic review prompt", async () => {
    const runMock = mock(async () => DEBATE_MAJORITY_PASS_RESULT);
    _semanticDeps.createDebateSession = mock(() => ({ run: runMock }));

    await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => makeMockAgent(PROPOSAL_PASS),
      DEBATE_REVIEW_ENABLED_CONFIG,
    );

    expect(runMock).toHaveBeenCalledTimes(1);
    const [promptArg] = runMock.mock.calls[0];
    expect(typeof promptArg).toBe("string");
    expect(promptArg).toContain("semantic code reviewer");
  });

  test("AC3: agent.complete() is NOT called when debate is enabled and debate runs", async () => {
    const runMock = mock(async () => DEBATE_MAJORITY_PASS_RESULT);
    _semanticDeps.createDebateSession = mock(() => ({ run: runMock }));

    const agentCompleteMock = mock(async () => PROPOSAL_PASS);
    const mockAgent = makeMockAgent(PROPOSAL_PASS);
    (mockAgent.complete as ReturnType<typeof mock>) = agentCompleteMock;

    await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => mockAgent,
      DEBATE_REVIEW_ENABLED_CONFIG,
    );

    expect(agentCompleteMock).not.toHaveBeenCalled();
  });

  test("AC3: agent.run() called once when debate is disabled", async () => {
    const createDebateMock = mock(() => ({
      run: mock(async () => DEBATE_MAJORITY_PASS_RESULT),
    }));
    _semanticDeps.createDebateSession = createDebateMock;

    const mockAgent = makeMockAgent(PROPOSAL_PASS);
    const agentRunMock = mockAgent.run as ReturnType<typeof mock>;

    await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => mockAgent,
      { debate: { enabled: false, agents: 0, stages: {} as never } } as NaxConfig,
    );

    expect(agentRunMock).toHaveBeenCalledTimes(1);
    expect(createDebateMock).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC4: majority resolver — success reflects majority vote on "passed" field
  // ─────────────────────────────────────────────────────────────────────────

  test("AC4: success=true when majority (2 of 3) proposals have passed=true", async () => {
    _semanticDeps.createDebateSession = mock(() => ({
      run: mock(async () => DEBATE_MAJORITY_PASS_RESULT),
    }));

    const result = await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => makeMockAgent(PROPOSAL_PASS),
      DEBATE_REVIEW_ENABLED_CONFIG,
    );

    expect(result.success).toBe(true);
  });

  test("AC4: success=false when majority (2 of 3) proposals have passed=false", async () => {
    _semanticDeps.createDebateSession = mock(() => ({
      run: mock(async () => DEBATE_MAJORITY_FAIL_RESULT),
    }));

    const result = await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => makeMockAgent(PROPOSAL_PASS),
      DEBATE_REVIEW_ENABLED_CONFIG,
    );

    expect(result.success).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC5: majority resolver — findings merged and deduplicated by file+line
  // ─────────────────────────────────────────────────────────────────────────

  test("AC5: findings contains entries from all debaters when majority fails", async () => {
    _semanticDeps.createDebateSession = mock(() => ({
      run: mock(async () => DEBATE_MAJORITY_FAIL_RESULT),
    }));

    const result = await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => makeMockAgent(PROPOSAL_PASS),
      DEBATE_REVIEW_ENABLED_CONFIG,
    );

    expect(result.findings).toBeDefined();
    expect((result.findings ?? []).length).toBeGreaterThan(0);
  });

  test("AC5: findings are deduplicated — same file+line appears only once", async () => {
    // DEBATE_DUPLICATE_FINDINGS_RESULT has:
    // - claude: [{file: semantic.ts, line: 10}]
    // - opencode: [{file: semantic.ts, line: 10}, {file: plan.ts, line: 200}]
    // Expected merged+deduped: 2 findings (not 3)
    _semanticDeps.createDebateSession = mock(() => ({
      run: mock(async () => DEBATE_DUPLICATE_FINDINGS_RESULT),
    }));

    const result = await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => makeMockAgent(PROPOSAL_PASS),
      DEBATE_REVIEW_ENABLED_CONFIG,
    );

    expect(result.findings).toBeDefined();
    // Both debaters report semantic.ts:10, but it should appear only once
    const findings = result.findings ?? [];
    const dedupeKeys = findings.map((f) => `${f.file}:${f.line}`);
    const uniqueKeys = [...new Set(dedupeKeys)];
    expect(dedupeKeys.length).toBe(uniqueKeys.length);
  });

  test("AC5: findings from both debaters are included when they report different issues", async () => {
    _semanticDeps.createDebateSession = mock(() => ({
      run: mock(async () => DEBATE_DUPLICATE_FINDINGS_RESULT),
    }));

    const result = await runSemanticReview(
      WORKDIR,
      STORY_GIT_REF,
      STORY,
      SEMANTIC_CONFIG,
      () => makeMockAgent(PROPOSAL_PASS),
      DEBATE_REVIEW_ENABLED_CONFIG,
    );

    const findings = result.findings ?? [];
    const files = findings.map((f) => f.file);
    // Expect both files to appear (no under-merging)
    expect(files).toContain("src/review/semantic.ts");
    expect(files).toContain("src/cli/plan.ts");
  });
});
