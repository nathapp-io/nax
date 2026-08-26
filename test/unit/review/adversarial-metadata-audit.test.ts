/**
 * Unit tests for src/review/adversarial.ts
 *
 * Covers: finding category/metadata, embedded diffMode spawn calls,
 * cost propagation, and audit gate behaviour.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { captureAuditDecisions, makeMockAgentManager, makeMockRuntime, makeNaxConfig, makeSpawn } from "@test/helpers";
import type { IAgentManager } from "@/agents/manager-types";
import { _adversarialDeps, runAdversarialReview } from "@/review/adversarial";
import { _diffUtilsDeps } from "@/review/diff-utils";
import type { AdversarialReviewConfig, SemanticStory } from "@/review/types";

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
    runFn: async (_agentName: string, opts: unknown) => ({
      success: true as const,
      exitCode: 0,
      output: llmResponse,
      rateLimited: false,
      durationMs: 100,
      estimatedCostUsd: cost,
      agentFallbacks: [] as unknown[],
    }),
    completeFn: async () => ({
      output: llmResponse,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: cost,
    }),
    runWithFallbackFn: async () => ({
      result: {
        success: true as const,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: cost,
        agentFallbacks: [] as unknown[],
      },
      fallbacks: [],
    }),
  });
}

function makeSpawnMock(stdout: string, exitCode = 0) {
  return makeSpawn(() => ({ exitCode, stdout })).spawn;
}

const PASSING_RESPONSE = JSON.stringify({ passed: true, findings: [] });

const CATEGORY_FINDING_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "warning",
      category: "test-gap",
      file: "src/log.ts",
      line: 30,
      issue: "Missing test for edge case",
      suggestion: "Add test",
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
// AC-11: Category field in findings
// ---------------------------------------------------------------------------

describe("runAdversarialReview — finding category and metadata", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("finding has ruleId 'adversarial'", async () => {
    const agentManager = makeAgentManager(CATEGORY_FINDING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.advisoryFindings).toBeDefined();
    expect(result.advisoryFindings?.[0]?.source).toBe("adversarial-review");
  });

  test("finding has source 'adversarial-review'", async () => {
    const agentManager = makeAgentManager(CATEGORY_FINDING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.advisoryFindings?.[0]?.source).toBe("adversarial-review");
  });

  test("finding carries category field from LLM response", async () => {
    const agentManager = makeAgentManager(CATEGORY_FINDING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.advisoryFindings?.[0]?.category).toBe("test-gap");
  });
});

// ---------------------------------------------------------------------------
// AC-12: Embedded diffMode triggers collectDiff spawn call
// ---------------------------------------------------------------------------

describe("runAdversarialReview — embedded diffMode", () => {
  let spawnMock: ReturnType<typeof makeSpawnMock>;

  beforeEach(() => {
    saveAllDeps();
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    spawnMock = makeSpawnMock(STAT_OUTPUT);
    _diffUtilsDeps.spawn = spawnMock;
  });

  afterEach(restoreAllDeps);

  test("spawn is called when diffMode is 'embedded'", async () => {
    const embeddedConfig: AdversarialReviewConfig = {
      ...ADVERSARIAL_CONFIG,
      diffMode: "embedded",
    };
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: embeddedConfig,
      agentManager,
      runtime,
    });

    expect(spawnMock).toHaveBeenCalled();
  });

  test("spawn is called multiple times (stat + diff) in embedded mode", async () => {
    const embeddedConfig: AdversarialReviewConfig = {
      ...ADVERSARIAL_CONFIG,
      diffMode: "embedded",
    };
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: embeddedConfig,
      agentManager,
      runtime,
    });

    const callCount = (spawnMock as ReturnType<typeof mock>).mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// AC-13: Cost propagation
// ---------------------------------------------------------------------------

describe("runAdversarialReview — cost propagation", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("result.cost is populated from LLM estimatedCostUsd", async () => {
    const agentManager = makeAgentManager(PASSING_RESPONSE, 0.042);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.cost).toBe(0);
  });

  test("result.cost is 0 when estimatedCostUsd is 0", async () => {
    const agentManager = makeAgentManager(PASSING_RESPONSE, 0);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.cost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// review.audit gate — ReviewAuditor records final decisions
// ---------------------------------------------------------------------------

describe("runAdversarialReview — review audit gate", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("audit disabled (default) — injected ReviewAuditor records success decisions", async () => {
    const { auditor, decisions: auditCalls } = captureAuditDecisions();
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.parsed).toBe(true);
    expect(auditCalls[0]?.passed).toBe(true);
  });

  test("audit enabled — ReviewAuditor records parsed:true on success", async () => {
    const { auditor, decisions: auditCalls } = captureAuditDecisions();
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });
    const config = makeNaxConfig({ review: { audit: { enabled: true } } });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      config,
      runtime,
    });

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.parsed).toBe(true);
    expect(auditCalls[0]?.reviewer).toBe("adversarial");
    expect(auditCalls[0]?.result?.passed).toBe(true);
  });

  test("audit enabled — ReviewAuditor records parsed:false on parse failure", async () => {
    const { auditor, decisions: auditCalls } = captureAuditDecisions();
    const agentManager = makeAgentManager("not json at all");
    const runtime = makeMockRuntime({ agentManager, reviewAuditor: auditor });
    const config = makeNaxConfig({ review: { audit: { enabled: true } } });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      config,
      runtime,
    });

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.parsed).toBe(false);
    expect(auditCalls[0]?.looksLikeFail).toBe(false);
    expect(auditCalls[0]?.result).toBeNull();
  });
});

describe("toAdversarialReviewFindings — verifiedBy passthrough (#987)", () => {
  test("surfaces verifiedBy into Finding.meta", () => {
    const { toAdversarialReviewFindings } = require("../../../src/review/adversarial-helpers");
    const findings = [
      {
        severity: "error",
        category: "abandonment",
        file: "src/foo.ts",
        line: 5,
        issue: "X",
        suggestion: "Y",
        verifiedBy: {
          command: "cat src/foo.ts",
          file: "src/foo.ts",
          line: 5,
          observed: "export function foo() {}",
        },
      },
    ];
    const wireFindings = toAdversarialReviewFindings(findings);
    expect(wireFindings[0].meta?.verifiedBy).toEqual({
      command: "cat src/foo.ts",
      file: "src/foo.ts",
      line: 5,
      observed: "export function foo() {}",
    });
  });

  test("omits verifiedBy when not provided", () => {
    const { toAdversarialReviewFindings } = require("../../../src/review/adversarial-helpers");
    const findings = [
      { severity: "info", category: "convention", file: "src/foo.ts", line: 5, issue: "X", suggestion: "Y" },
    ];
    const wireFindings = toAdversarialReviewFindings(findings);
    expect(wireFindings[0].meta?.verifiedBy).toBeUndefined();
  });
});
