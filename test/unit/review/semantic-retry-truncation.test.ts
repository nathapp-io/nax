/**
 * Unit tests for truncation-aware condensed retry in src/review/semantic.ts
 *
 * The ACP adapter tail-truncates output at MAX_AGENT_OUTPUT_CHARS (5000 chars).
 * looksLikeTruncatedJson() fires when the response length is within 100 chars of
 * that cap, indicating the tail was cut off mid-stream.
 *
 * Tests cover parity with PR #674 (adversarial condensed retry) — see #676:
 * - Condensed retry prompt used when response is at the ACP output cap
 * - Standard retry prompt used when response is short unparseable text (not at cap)
 * - Retry fires even when response is at cap before parse attempt
 * - Succeeds when condensed retry returns valid JSON after cap-length truncation
 * - Logs isTruncated:true/false on retry entry
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentResult } from "../../../src/agents/types";
import type { IAgentManager } from "../../../src/agents/manager-types";
import type { AgentAdapter } from "../../../src/agents/types";
import * as loggerModule from "../../../src/logger";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { makeAgentAdapter, makeMockAgentManager } from "../../helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORY: SemanticStory = {
  id: "US-002",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: ["runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig"],
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

// The ACP adapter tail-truncates at MAX_AGENT_OUTPUT_CHARS (5000). A response
// at 4950 chars is within 100 of the cap — looksLikeTruncatedJson() returns true.
const AT_CAP_UNPARSEABLE = "x".repeat(4950);

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
  return makeAgentAdapter({
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
  });
}

function makeMultiCallAgentManager(responses: string[], costPerCall = 0.5): IAgentManager {
  const adapter = makeMultiCallAgent(responses, costPerCall);

  return makeMockAgentManager({
    getDefaultAgent: "claude",
    getAgentFn: () => adapter,
    runFn: async (_agentName: string, opts: unknown) => {
      const result = await adapter.run(opts as Parameters<typeof adapter.run>[0]);
      return { ...result, agentFallbacks: [] };
    },
  });
}

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
// Truncation detection — condensed retry prompt
// ---------------------------------------------------------------------------

describe("runSemanticReview — truncation-detected condensed retry", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("uses condensed retry prompt when response length is at the ACP output cap", async () => {
    const agentManager = makeMultiCallAgentManager([AT_CAP_UNPARSEABLE, PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    const calls = (agentManager.getAgent("claude").run as ReturnType<typeof mock>).mock.calls;
    const retryPrompt = (calls[1][0] as Record<string, unknown>).prompt as string;
    expect(retryPrompt).toContain("truncated");
  });

  test("uses standard retry prompt when response is short unparseable text (not at cap)", async () => {
    const nonJson = "here is my analysis: the code looks fine overall";
    const agentManager = makeMultiCallAgentManager([nonJson, PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    const calls = (agentManager.getAgent("claude").run as ReturnType<typeof mock>).mock.calls;
    const retryPrompt = (calls[1][0] as Record<string, unknown>).prompt as string;
    expect(retryPrompt).not.toContain("truncated");
  });

  test("condensed retry prompt caps findings — prompt mentions a number limit", async () => {
    const agentManager = makeMultiCallAgentManager([AT_CAP_UNPARSEABLE, PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    const calls = (agentManager.getAgent("claude").run as ReturnType<typeof mock>).mock.calls;
    const retryPrompt = (calls[1][0] as Record<string, unknown>).prompt as string;
    expect(retryPrompt).toMatch(/\d+ finding/);
  });

  test("fires retry when response is at cap even before attempting parse", async () => {
    const agentManager = makeMultiCallAgentManager([AT_CAP_UNPARSEABLE, PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    const calls = (agentManager.getAgent("claude").run as ReturnType<typeof mock>).mock.calls;
    expect(calls).toHaveLength(2);
  });

  test("succeeds when condensed retry returns valid JSON after cap-length truncation", async () => {
    const condensedResponse = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", line: 1, issue: "missing impl", suggestion: "add it" }],
    });
    const agentManager = makeMultiCallAgentManager([AT_CAP_UNPARSEABLE, condensedResponse]);

    const result = await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    expect(result.success).toBe(false);
    expect(result.findings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Truncation detection — logging
// ---------------------------------------------------------------------------

describe("runSemanticReview — truncation retry logging", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("logs isTruncated:true when response length is at the ACP output cap", async () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const agentManager = makeMultiCallAgentManager([AT_CAP_UNPARSEABLE, PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    const parseFailLog = logger.infoCalls.find((c) => c.message.includes("JSON parse failed"));
    expect(parseFailLog?.data?.isTruncated).toBe(true);

    loggerSpy.mockRestore();
  });

  test("logs isTruncated:false when response is short unparseable text (not at cap)", async () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const agentManager = makeMultiCallAgentManager(["not json text", PASSING_LLM_RESPONSE]);

    await runSemanticReview("/tmp/wd", "abc123", STORY, DEFAULT_SEMANTIC_CONFIG, agentManager);

    const parseFailLog = logger.infoCalls.find((c) => c.message.includes("JSON parse failed"));
    expect(parseFailLog?.data?.isTruncated).toBe(false);

    loggerSpy.mockRestore();
  });
});
