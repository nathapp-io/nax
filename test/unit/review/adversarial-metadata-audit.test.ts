/**
 * Unit tests for src/review/adversarial.ts
 *
 * Covers: finding category/metadata, embedded diffMode spawn calls,
 * cost propagation, and audit gate behaviour.
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

const CATEGORY_FINDING_RESPONSE = JSON.stringify({
  passed: false,
  findings: [
    {
      severity: "error",
      category: "test-gap",
      file: "src/auth.ts",
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
// AC-11: Category field in findings
// ---------------------------------------------------------------------------

describe("runAdversarialReview — finding category and metadata", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("finding has ruleId 'adversarial'", async () => {
    const agent = makeAgent(CATEGORY_FINDING_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.findings).toBeDefined();
    expect(result.findings![0].ruleId).toBe("adversarial");
  });

  test("finding has source 'adversarial-review'", async () => {
    const agent = makeAgent(CATEGORY_FINDING_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.findings![0].source).toBe("adversarial-review");
  });

  test("finding carries category field from LLM response", async () => {
    const agent = makeAgent(CATEGORY_FINDING_RESPONSE);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.findings![0].category).toBe("test-gap");
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
    _adversarialDeps.readAcpSession = mock(async () => null);
  });

  afterEach(restoreAllDeps);

  test("spawn is called when diffMode is 'embedded'", async () => {
    const embeddedConfig: AdversarialReviewConfig = {
      ...ADVERSARIAL_CONFIG,
      diffMode: "embedded",
    };
    const agent = makeAgent(PASSING_RESPONSE);

    await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      embeddedConfig,
      () => agent,
    );

    expect(spawnMock).toHaveBeenCalled();
  });

  test("spawn is called multiple times (stat + diff) in embedded mode", async () => {
    const embeddedConfig: AdversarialReviewConfig = {
      ...ADVERSARIAL_CONFIG,
      diffMode: "embedded",
    };
    const agent = makeAgent(PASSING_RESPONSE);

    await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      embeddedConfig,
      () => agent,
    );

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

  test("result.cost is populated from LLM estimatedCost", async () => {
    const agent = makeAgent(PASSING_RESPONSE, 0.042);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.cost).toBe(0.042);
  });

  test("result.cost is 0 when estimatedCost is 0", async () => {
    const agent = makeAgent(PASSING_RESPONSE, 0);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.cost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// review.audit gate — writeReviewAudit only called when audit.enabled === true
// ---------------------------------------------------------------------------

describe("runAdversarialReview — review audit gate", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("audit disabled (default) — writeReviewAudit not called on success", async () => {
    const auditCalls: unknown[] = [];
    _adversarialDeps.writeReviewAudit = mock(async (entry) => { auditCalls.push(entry); });
    const agent = makeAgent(PASSING_RESPONSE);

    await runAdversarialReview("/tmp/wd", "abc123", STORY, ADVERSARIAL_CONFIG, () => agent);

    expect(auditCalls).toHaveLength(0);
  });

  test("audit enabled — writeReviewAudit called with parsed:true on success", async () => {
    const auditCalls: unknown[] = [];
    _adversarialDeps.writeReviewAudit = mock(async (entry) => { auditCalls.push(entry); });
    const agent = makeAgent(PASSING_RESPONSE);
    const naxConfig = { review: { audit: { enabled: true } } } as any;

    await runAdversarialReview("/tmp/wd", "abc123", STORY, ADVERSARIAL_CONFIG, () => agent, naxConfig);

    expect(auditCalls).toHaveLength(1);
    expect((auditCalls[0] as any).parsed).toBe(true);
    expect((auditCalls[0] as any).reviewer).toBe("adversarial");
  });

  test("audit enabled — writeReviewAudit called with parsed:false on parse failure", async () => {
    const auditCalls: unknown[] = [];
    _adversarialDeps.writeReviewAudit = mock(async (entry) => { auditCalls.push(entry); });
    const agent = makeAgent("not json at all");
    const naxConfig = { review: { audit: { enabled: true } } } as any;

    await runAdversarialReview("/tmp/wd", "abc123", STORY, ADVERSARIAL_CONFIG, () => agent, naxConfig);

    expect(auditCalls).toHaveLength(1);
    expect((auditCalls[0] as any).parsed).toBe(false);
    expect((auditCalls[0] as any).looksLikeFail).toBe(false);
    expect((auditCalls[0] as any).result).toBeNull();
  });
});
