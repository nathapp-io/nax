/**
 * Unit tests for featureName threading in runSemanticReview (US-002)
 *
 * Tests cover:
 * - AC-1: runSemanticReview() accepts featureName? parameter
 * - AC-5: complete() call uses buildSessionName(workdir, featureName, story.id, "semantic")
 * - AC-6: debate branch passes received featureName (not story.id) to createDebateSession()
 * - AC-7: when featureName is undefined, buildSessionName is still called
 * - AC-8: hardcoded `nax-semantic-${story.id}` no longer used
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { buildSessionName } from "../../../src/agents/acp/adapter";
import type { NaxConfig } from "../../../src/config";
import type { AgentAdapter } from "../../../src/agents/types";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-002",
  title: "Thread featureName through review call chain",
  description: "Add featureName parameter to runSemanticReview",
  acceptanceCriteria: ["featureName is passed to agent.complete via buildSessionName"],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  rules: [],
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const WORKDIR = "/tmp/test-project";
const FEATURE_NAME = "semantic-session-continuity";
const GIT_REF = "abc123def";
const PASSING_RESPONSE = JSON.stringify({ passed: true, findings: [] });

function makeSpawnMock(stdout: string, exitCode = 0) {
  return mock((_opts: unknown) => ({
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
    kill: () => {},
  })) as unknown as typeof _semanticDeps.spawn;
}

function makeAgentWithCompleteMock(completeMock: ReturnType<typeof mock>): AgentAdapter {
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: { supportedTiers: [], supportedTestStrategies: [], features: {} } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => { throw new Error("not used"); }),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    complete: completeMock,
  } as unknown as AgentAdapter;
}

// ---------------------------------------------------------------------------
// AC-1 + AC-5: sessionName uses buildSessionName when featureName is provided
// ---------------------------------------------------------------------------

describe("runSemanticReview — buildSessionName for complete() (US-002 AC-5)", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
    _semanticDeps.spawn = makeSpawnMock("diff content", 0);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
    mock.restore();
  });

  test("calls agent.complete with sessionName from buildSessionName when featureName is provided", async () => {
    const completeMock = mock(async () => PASSING_RESPONSE);
    const agent = makeAgentWithCompleteMock(completeMock);
    const expectedSessionName = buildSessionName(WORKDIR, FEATURE_NAME, STORY.id, "semantic");

    await runSemanticReview(WORKDIR, GIT_REF, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent, undefined, FEATURE_NAME);

    expect(completeMock).toHaveBeenCalled();
    const [, opts] = completeMock.mock.calls[0] as [unknown, { sessionName?: string }];
    expect(opts?.sessionName).toBe(expectedSessionName);
  });

  test("sessionName includes workdir hash component (not hardcoded story ID prefix)", async () => {
    const completeMock = mock(async () => PASSING_RESPONSE);
    const agent = makeAgentWithCompleteMock(completeMock);

    await runSemanticReview(WORKDIR, GIT_REF, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent, undefined, FEATURE_NAME);

    const [, opts] = completeMock.mock.calls[0] as [unknown, { sessionName?: string }];
    // buildSessionName produces nax-<hash>-... not nax-semantic-...
    expect(opts?.sessionName).toMatch(/^nax-[a-f0-9]{8}-/);
  });

  // AC-8: no hardcoded nax-semantic-${storyId}
  test("does NOT use hardcoded `nax-semantic-US-002` format for sessionName", async () => {
    const completeMock = mock(async () => PASSING_RESPONSE);
    const agent = makeAgentWithCompleteMock(completeMock);

    await runSemanticReview(WORKDIR, GIT_REF, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent, undefined, FEATURE_NAME);

    const [, opts] = completeMock.mock.calls[0] as [unknown, { sessionName?: string }];
    expect(opts?.sessionName).not.toBe(`nax-semantic-${STORY.id}`);
  });
});

// ---------------------------------------------------------------------------
// AC-7: when featureName is undefined, buildSessionName is still called
// ---------------------------------------------------------------------------

describe("runSemanticReview — buildSessionName when featureName is undefined (US-002 AC-7)", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
    _semanticDeps.spawn = makeSpawnMock("diff content", 0);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
    mock.restore();
  });

  test("uses buildSessionName(workdir, undefined, story.id, semantic) when featureName is omitted", async () => {
    const completeMock = mock(async () => PASSING_RESPONSE);
    const agent = makeAgentWithCompleteMock(completeMock);
    const expectedSessionName = buildSessionName(WORKDIR, undefined, STORY.id, "semantic");

    await runSemanticReview(WORKDIR, GIT_REF, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect(completeMock).toHaveBeenCalled();
    const [, opts] = completeMock.mock.calls[0] as [unknown, { sessionName?: string }];
    expect(opts?.sessionName).toBe(expectedSessionName);
  });

  test("does NOT fall back to hardcoded `nax-semantic-storyId` when featureName is undefined", async () => {
    const completeMock = mock(async () => PASSING_RESPONSE);
    const agent = makeAgentWithCompleteMock(completeMock);

    await runSemanticReview(WORKDIR, GIT_REF, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const [, opts] = completeMock.mock.calls[0] as [unknown, { sessionName?: string }];
    expect(opts?.sessionName).not.toBe(`nax-semantic-${STORY.id}`);
  });

  test("sessionName still starts with nax- hash prefix when featureName is undefined", async () => {
    const completeMock = mock(async () => PASSING_RESPONSE);
    const agent = makeAgentWithCompleteMock(completeMock);

    await runSemanticReview(WORKDIR, GIT_REF, STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const [, opts] = completeMock.mock.calls[0] as [unknown, { sessionName?: string }];
    expect(opts?.sessionName).toMatch(/^nax-[a-f0-9]{8}-/);
  });
});

// ---------------------------------------------------------------------------
// AC-6: debate branch passes received featureName (not story.id) to createDebateSession
// ---------------------------------------------------------------------------

describe("runSemanticReview — debate branch featureName bug fix (US-002 AC-6)", () => {
  let origSpawn: typeof _semanticDeps.spawn;
  let origIsGitRefValid: typeof _semanticDeps.isGitRefValid;
  let origGetMergeBase: typeof _semanticDeps.getMergeBase;
  let origCreateDebateSession: typeof _semanticDeps.createDebateSession;

  function makeDebateSessionMock(): ReturnType<typeof _semanticDeps.createDebateSession> {
    return {
      run: mock(async () => ({
        proposals: [
          { output: PASSING_RESPONSE, agentIndex: 0, durationMs: 10 },
        ],
      })),
    } as unknown as ReturnType<typeof _semanticDeps.createDebateSession>;
  }

  function makeNaxConfigWithDebate(): NaxConfig {
    return {
      debate: {
        enabled: true,
        stages: {
          review: {
            enabled: true,
            agents: ["fast", "fast"],
          },
        },
      },
    } as unknown as NaxConfig;
  }

  // A non-null agent is required to pass the early-return guard before the debate path
  function makeStubAgent(): AgentAdapter {
    return makeAgentWithCompleteMock(mock(async () => PASSING_RESPONSE));
  }

  beforeEach(() => {
    origSpawn = _semanticDeps.spawn;
    origIsGitRefValid = _semanticDeps.isGitRefValid;
    origGetMergeBase = _semanticDeps.getMergeBase;
    origCreateDebateSession = _semanticDeps.createDebateSession;
    _semanticDeps.isGitRefValid = mock(async () => true);
    _semanticDeps.getMergeBase = mock(async () => undefined);
    _semanticDeps.spawn = makeSpawnMock("diff content", 0);
  });

  afterEach(() => {
    _semanticDeps.spawn = origSpawn;
    _semanticDeps.isGitRefValid = origIsGitRefValid;
    _semanticDeps.getMergeBase = origGetMergeBase;
    _semanticDeps.createDebateSession = origCreateDebateSession;
    mock.restore();
  });

  test("passes received featureName to createDebateSession (not story.id)", async () => {
    const capturedOpts: unknown[] = [];
    _semanticDeps.createDebateSession = mock((opts) => {
      capturedOpts.push(opts);
      return makeDebateSessionMock();
    });

    await runSemanticReview(
      WORKDIR,
      GIT_REF,
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => makeStubAgent(),
      makeNaxConfigWithDebate(),
      FEATURE_NAME,
    );

    expect(capturedOpts).toHaveLength(1);
    const opts = capturedOpts[0] as { featureName?: string };
    expect(opts.featureName).toBe(FEATURE_NAME);
  });

  test("does NOT pass story.id as featureName to createDebateSession", async () => {
    const capturedOpts: unknown[] = [];
    _semanticDeps.createDebateSession = mock((opts) => {
      capturedOpts.push(opts);
      return makeDebateSessionMock();
    });

    await runSemanticReview(
      WORKDIR,
      GIT_REF,
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => makeStubAgent(),
      makeNaxConfigWithDebate(),
      FEATURE_NAME,
    );

    const opts = capturedOpts[0] as { featureName?: string; storyId?: string };
    // storyId should still be the story ID
    expect(opts.storyId).toBe(STORY.id);
    // featureName must NOT be the story ID (this was the bug at line 392)
    expect(opts.featureName).not.toBe(STORY.id);
  });

  test("passes undefined featureName to createDebateSession when featureName not provided", async () => {
    const capturedOpts: unknown[] = [];
    _semanticDeps.createDebateSession = mock((opts) => {
      capturedOpts.push(opts);
      return makeDebateSessionMock();
    });

    await runSemanticReview(
      WORKDIR,
      GIT_REF,
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => makeStubAgent(),
      makeNaxConfigWithDebate(),
      // no featureName
    );

    expect(capturedOpts).toHaveLength(1);
    const opts = capturedOpts[0] as { featureName?: string };
    // Must not pass story.id in place of featureName
    expect(opts.featureName).not.toBe(STORY.id);
    expect(opts.featureName).toBeUndefined();
  });
});
