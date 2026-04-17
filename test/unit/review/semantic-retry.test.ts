/**
 * Unit tests for the JSON retry logic in src/review/semantic.ts
 *
 * Tests cover:
 * - Retry succeeds: initial response unparseable, retry returns valid JSON
 * - Retry failure: retry call throws, falls through to fail-open
 * - agent.run called twice when initial response is unparseable
 * - Retry call uses keepSessionOpen: false
 * - Cost accumulated from both initial and retry calls
 * - Logging: info on parse fail + retry, info on retry success, warn on exhaustion
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";
import type { AgentAdapter } from "../../../src/agents/types";
import * as loggerModule from "../../../src/logger";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-002",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: [
    "runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig, and modelResolver",
  ],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  modelTier: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });

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
  const agentResultFor = (output: string): AgentResult => ({
    success: true,
    exitCode: 0,
    output,
    rateLimited: false,
    durationMs: 100,
    estimatedCost: costPerCall,
  });
  return {
    name: "mock",
    displayName: "Mock Multi-Call Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: [],
      maxContextTokens: 128_000,
      features: new Set(),
    } as unknown as AgentAdapter["capabilities"],
    isInstalled: mock(async () => true),
    run: mock(async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1];
      callIndex++;
      return agentResultFor(response);
    }),
    closeSession: mock(async () => {}),
    closePhysicalSession: mock(async () => {}),
    buildCommand: mock(() => []),
    plan: mock(async () => { throw new Error("not used"); }),
    decompose: mock(async () => { throw new Error("not used"); }),
    complete: mock(async (_prompt: string) => {
      throw new Error("complete() must NOT be called in non-debate path");
    }),
  } as unknown as AgentAdapter;
}

// ---------------------------------------------------------------------------
// Logger mock helpers
// ---------------------------------------------------------------------------

interface LogCall {
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

interface MockLogger {
  info: ReturnType<typeof mock>;
  warn: ReturnType<typeof mock>;
  debug: ReturnType<typeof mock>;
  infoCalls: LogCall[];
  warnCalls: LogCall[];
}

function makeLogger(): MockLogger {
  const infoCalls: LogCall[] = [];
  const warnCalls: LogCall[] = [];
  return {
    infoCalls,
    warnCalls,
    info: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      infoCalls.push({ stage, message, data });
    }),
    warn: mock((stage: string, message: string, data?: Record<string, unknown>) => {
      warnCalls.push({ stage, message, data });
    }),
    debug: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Saved deps
// ---------------------------------------------------------------------------

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
let origWriteReviewAudit: typeof _semanticDeps.writeReviewAudit;

function saveAllDeps() {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _semanticDeps.writeReviewAudit;
}

function restoreAllDeps() {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _semanticDeps.writeReviewAudit = origWriteReviewAudit;
}

function setupHappyPathDeps() {
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = makeSpawnMock("src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)");
  _semanticDeps.writeReviewAudit = mock(async () => {});
}

// ---------------------------------------------------------------------------
// JSON retry — success path
// ---------------------------------------------------------------------------

describe("runSemanticReview — JSON retry succeeds", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("uses valid JSON from retry when initial response is unparseable", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_LLM_RESPONSE]);

    const result = await runSemanticReview(
      "/tmp/wd",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Semantic review passed");
  });

  test("agent.run called twice when initial response is unparseable", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect((agent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
  });

  test("initial call uses keepSessionOpen: true so retry has conversation history (session closes by end of runReview, ADR-008)", async () => {
    const agent = makeMultiCallAgent([PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const calls = (agent.run as ReturnType<typeof mock>).mock.calls;
    expect((calls[0][0] as Record<string, unknown>).keepSessionOpen).toBe(true);
  });

  test("retry call uses keepSessionOpen: false to close the session", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const calls = (agent.run as ReturnType<typeof mock>).mock.calls;
    expect((calls[1][0] as Record<string, unknown>).keepSessionOpen).toBe(false);
  });

  test("agent.closePhysicalSession called once to close the session after runReview completes", async () => {
    const agent = makeMultiCallAgent([PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect((agent.closePhysicalSession as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test("agent.closePhysicalSession called even when retry was needed (retry-exhausted path)", async () => {
    const agent = makeMultiCallAgent(["this is not json at all", PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect((agent.closePhysicalSession as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test("agent.run called once when initial response is valid JSON", async () => {
    const agent = makeMultiCallAgent([PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    expect((agent.run as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });

  test("cost accumulated from both initial and retry calls", async () => {
    const agent = makeMultiCallAgent(["not json", PASSING_LLM_RESPONSE], 0.5);

    const result = await runSemanticReview(
      "/tmp/wd",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => agent,
    );

    expect(result.cost).toBeCloseTo(1.0);
  });
});

// ---------------------------------------------------------------------------
// JSON retry — failure paths
// ---------------------------------------------------------------------------

describe("runSemanticReview — JSON retry failure paths", () => {
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
      capabilities: {
        supportedTiers: [],
        maxContextTokens: 128_000,
        features: new Set(),
      } as unknown as AgentAdapter["capabilities"],
      isInstalled: mock(async () => true),
      run: mock(async () => {
        callIndex++;
        if (callIndex === 1) {
          return { success: true, exitCode: 0, output: "not json at all", rateLimited: false, durationMs: 100, estimatedCost: 0 } as AgentResult;
        }
        throw new Error("retry connection failure");
      }),
      closeSession: mock(async () => {}),
      closePhysicalSession: mock(async () => {}),
      buildCommand: mock(() => []),
      plan: mock(async () => { throw new Error("not used"); }),
      decompose: mock(async () => { throw new Error("not used"); }),
      complete: mock(async (_prompt: string) => { throw new Error("not used"); }),
    } as unknown as AgentAdapter;

    const result = await runSemanticReview(
      "/tmp/wd",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("fail-open");
  });

  test("fails closed when retry also returns truncated JSON with passed:false", async () => {
    const truncated = '{ "passed": false, "findings": [{ "severity": "error"';
    const agent = makeMultiCallAgent(["not json", truncated]);

    const result = await runSemanticReview(
      "/tmp/wd",
      "abc123",
      STORY,
      DEFAULT_SEMANTIC_CONFIG,
      () => agent,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("passed:false");
  });
});

// ---------------------------------------------------------------------------
// Logging behaviour
// ---------------------------------------------------------------------------

describe("runSemanticReview — retry logging", () => {
  let loggerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(() => {
    restoreAllDeps();
    loggerSpy?.mockRestore();
  });

  test("logs info 'JSON parse failed, retrying (1/1)' with rawHead when initial parse fails", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const badOutput = "this is not json at all";
    const agent = makeMultiCallAgent([badOutput, PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const parseFailLog = logger.infoCalls.find((c) => c.message.includes("JSON parse failed"));
    expect(parseFailLog).toBeDefined();
    expect(parseFailLog?.stage).toBe("semantic");
    expect(parseFailLog?.data?.rawHead).toContain("not json");
    expect(parseFailLog?.data?.responseLen).toBe(badOutput.length);
  });

  test("logs info 'JSON retry succeeded' when retry parse passes", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const agent = makeMultiCallAgent(["not json", PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const successLog = logger.infoCalls.find((c) => c.message.includes("JSON retry succeeded"));
    expect(successLog).toBeDefined();
    expect(successLog?.stage).toBe("semantic");
    expect(successLog?.data?.responseLen).toBeGreaterThan(0);
  });

  test("does not log 'JSON retry succeeded' when initial parse succeeds (no retry needed)", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const agent = makeMultiCallAgent([PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const retryLog = logger.infoCalls.find((c) => c.message.includes("retry"));
    expect(retryLog).toBeUndefined();
  });

  test("logs warn 'Retry exhausted — fail-open' with retries:1 and rawHead when both attempts fail", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const badOutput = "still not json after retry";
    const agent = makeMultiCallAgent(["not json", badOutput]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, () => agent);

    const exhaustLog = logger.warnCalls.find((c) => c.message.includes("Retry exhausted"));
    expect(exhaustLog).toBeDefined();
    expect(exhaustLog?.stage).toBe("semantic");
    expect(exhaustLog?.data?.retries).toBe(1);
    expect(exhaustLog?.data?.rawHead).toContain("not json");
    expect(exhaustLog?.data?.responseLen).toBe(badOutput.length);
  });
});
