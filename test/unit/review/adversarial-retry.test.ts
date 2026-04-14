/**
 * Unit tests for the JSON retry logic in src/review/adversarial.ts
 *
 * Tests cover:
 * - Retry succeeds: initial response unparseable, retry returns valid JSON
 * - Retry failure: retry call throws, falls through to fail-open
 * - agent.run called twice when initial response is unparseable
 * - Retry call uses keepSessionOpen: false
 * - Cost accumulated from both initial and retry calls
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

const PASSING_RESPONSE = JSON.stringify({ passed: true, findings: [] });
const STAT_OUTPUT = "src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Build a mock AgentAdapter whose run() returns a different response per call.
 * responses[0] is returned on the first call, responses[1] on the second, etc.
 * The last entry is reused for any additional calls beyond the array length.
 */
function makeMultiCallAgent(responses: string[], costPerCall = 0.5): AgentAdapter {
  let callIndex = 0;
  return {
    name: "mock",
    displayName: "Mock Multi-Call Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: [],
      supportedTestStrategies: [],
      features: {},
    } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return { output: response, estimatedCost: costPerCall };
    }),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    complete: mock(async (_prompt: string) => responses[0]),
  } as unknown as AgentAdapter;
}

// ---------------------------------------------------------------------------
// Saved deps
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
  _adversarialDeps.writeReviewAudit = mock(async () => {});
}

// ---------------------------------------------------------------------------
// JSON retry — success path
// ---------------------------------------------------------------------------

describe("runAdversarialReview — JSON retry succeeds", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("uses valid JSON from retry when initial response is unparseable", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_RESPONSE]);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Adversarial review passed");
  });

  test("agent.run called twice when initial response is unparseable", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_RESPONSE]);

    await runAdversarialReview("/tmp/wd", "abc123", STORY, ADVERSARIAL_CONFIG, () => agent);

    expect((agent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });

  test("retry call uses keepSessionOpen: false to close the session", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_RESPONSE]);

    await runAdversarialReview("/tmp/wd", "abc123", STORY, ADVERSARIAL_CONFIG, () => agent);

    const calls = (agent.run as ReturnType<typeof mock>).mock.calls;
    expect((calls[1][0] as Record<string, unknown>).keepSessionOpen).toBe(false);
  });

  test("initial call uses keepSessionOpen: false (stateless scorer, ADR-008)", async () => {
    const agent = makeMultiCallAgent([PASSING_RESPONSE]);

    await runAdversarialReview("/tmp/wd", "abc123", STORY, ADVERSARIAL_CONFIG, () => agent);

    const calls = (agent.run as ReturnType<typeof mock>).mock.calls;
    expect((calls[0][0] as Record<string, unknown>).keepSessionOpen).toBe(false);
  });

  test("agent.run called once when initial response is valid JSON", async () => {
    const agent = makeMultiCallAgent([PASSING_RESPONSE]);

    await runAdversarialReview("/tmp/wd", "abc123", STORY, ADVERSARIAL_CONFIG, () => agent);

    expect((agent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test("cost accumulated from both initial and retry calls", async () => {
    const agent = makeMultiCallAgent(["not json", PASSING_RESPONSE], 0.5);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.cost).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// JSON retry — failure paths
// ---------------------------------------------------------------------------

describe("runAdversarialReview — JSON retry failure paths", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("falls through to fail-open when retry call throws", async () => {
    let callIndex = 0;
    const agent = {
      name: "mock",
      displayName: "Mock Agent",
      binary: "mock",
      capabilities: { supportedTiers: [], supportedTestStrategies: [], features: {} } as unknown as AgentAdapter["capabilities"],
      isInstalled: mock(async () => true),
      run: mock(async () => {
        callIndex++;
        if (callIndex === 1) return { output: "not json at all", estimatedCost: 0 };
        throw new Error("retry connection failure");
      }),
      buildCommand: mock(() => []),
      plan: mock(async () => { throw new Error("not used"); }),
      decompose: mock(async () => { throw new Error("not used"); }),
      complete: mock(async (_prompt: string) => ""),
    } as unknown as AgentAdapter;

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("fail-open");
  });

  test("fails closed when retry also returns truncated JSON with passed:false", async () => {
    const truncated = '{ "passed": false, "findings": [{ "severity": "error"';
    const agent = makeMultiCallAgent(["not json", truncated]);

    const result = await runAdversarialReview(
      "/tmp/wd",
      "abc123",
      STORY,
      ADVERSARIAL_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("passed:false");
  });
});
