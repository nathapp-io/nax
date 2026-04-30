/**
 * Unit tests for the JSON retry logic in src/review/adversarial.ts
 *
 * ADR-019: Retry moved inside adversarialReviewOp.hopBody. runAdversarialReview
 * calls callOp once; retry is invisible at this level. Tests verify
 * observable outcomes (fail-open, looksLikeFail, success) and logging.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as loggerModule from "../../../src/logger";
import { _adversarialDeps, runAdversarialReview } from "../../../src/review/adversarial";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import type { AdversarialReviewConfig } from "../../../src/review/types";
import type { SemanticStory } from "../../../src/review/types";
import { makeMockAgentManager } from "../../helpers";
import { makeMockRuntime } from "../../helpers/runtime";

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

const PASSING_RESPONSE = JSON.stringify({ passed: true, findings: [] });
const STAT_OUTPUT = "src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)";

// ─── Logger mock helpers ─────────────────────────────────────────────────────

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

// ─── Saved deps ──────────────────────────────────────────────────────────────

let origSpawn: typeof _diffUtilsDeps.spawn;
let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
let origWriteReviewAudit: typeof _adversarialDeps.writeReviewAudit;
let origCallOp: typeof _adversarialDeps.callOp;

function saveAllDeps() {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _adversarialDeps.writeReviewAudit;
  origCallOp = _adversarialDeps.callOp;
}

function restoreAllDeps() {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _adversarialDeps.writeReviewAudit = origWriteReviewAudit;
  _adversarialDeps.callOp = origCallOp;
}

function setupHappyPathDeps(statContent = STAT_OUTPUT) {
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = mock((_opts: unknown) => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(statContent));
        controller.close();
      },
    }),
    stderr: new ReadableStream({ start(controller) { controller.close(); } }),
    kill: () => {},
  })) as unknown as typeof _diffUtilsDeps.spawn;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeAgentManager(llmResponse: string): ReturnType<typeof makeMockAgentManager> {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    runWithFallbackFn: async () => ({
      result: {
        success: true,
        exitCode: 0,
        output: llmResponse,
        rateLimited: false,
        durationMs: 100,
        estimatedCostUsd: 0,
        agentFallbacks: [],
      },
      fallbacks: [],
    }),
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("runAdversarialReview — JSON retry outcomes", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success when callOp returns valid findings", async () => {
    _adversarialDeps.callOp = mock(async () => ({
      passed: true,
      findings: [],
    }));
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Adversarial review passed");
  });

  test("returns fail-open when callOp returns failOpen", async () => {
    _adversarialDeps.callOp = mock(async () => ({
      passed: true,
      findings: [],
      failOpen: true,
    }));
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.output).toContain("fail-open");
  });

  test("returns failure when callOp returns looksLikeFail", async () => {
    _adversarialDeps.callOp = mock(async () => ({
      passed: false,
      findings: [],
      looksLikeFail: true,
    }));
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("passed:false");
  });

  test("returns failure with blocking findings when callOp returns findings", async () => {
    _adversarialDeps.callOp = mock(async () => ({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", line: 1, issue: "Bug", suggestion: "Fix" }],
    }));
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings![0].ruleId).toBe("adversarial");
  });

  test("returns fail-open when callOp throws", async () => {
    _adversarialDeps.callOp = mock(async () => { throw new Error("LLM call failed"); });
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.output).toContain("skipped");
  });
});

describe("runAdversarialReview — logging", () => {
  let loggerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(() => {
    restoreAllDeps();
    loggerSpy?.mockRestore();
  });

  test("logs info 'Adversarial review passed' on success", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    _adversarialDeps.callOp = mock(async () => ({ passed: true, findings: [] }));
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    const successLog = logger.infoCalls.find((c) => c.message.includes("Adversarial review passed"));
    expect(successLog).toBeDefined();
    expect(successLog?.stage).toBe("review");
  });

  test("logs warn 'Retry exhausted — fail-open' when callOp returns failOpen", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    _adversarialDeps.callOp = mock(async () => ({ passed: true, findings: [], failOpen: true }));
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    const exhaustLog = logger.warnCalls.find((c) => c.message.includes("Retry exhausted"));
    expect(exhaustLog).toBeDefined();
    expect(exhaustLog?.stage).toBe("adversarial");
  });

  test("logs warn 'LLM returned truncated JSON' when callOp returns looksLikeFail", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    _adversarialDeps.callOp = mock(async () => ({ passed: false, findings: [], looksLikeFail: true }));
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated JSON"));
    expect(truncatedLog).toBeDefined();
    expect(truncatedLog?.stage).toBe("adversarial");
  });

  test("does not log 'Retry exhausted' when callOp returns success", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    _adversarialDeps.callOp = mock(async () => ({ passed: true, findings: [] }));
    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    const retryLog = logger.warnCalls.find((c) => c.message.includes("Retry exhausted"));
    expect(retryLog).toBeUndefined();
  });
});

describe("adversarialReviewOp.hopBody — retry behaviour", () => {
  test("calls ctx.send twice when first response is unparseable", async () => {
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      if (sendCalls.length === 1) {
        return { output: "not json at all", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }
      return { output: PASSING_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        mode: "embedded",
      },
    } as any);

    expect(sendCalls).toHaveLength(2);
    expect(result.output).toBe(PASSING_RESPONSE);
  });

  test("calls ctx.send once when first response is valid JSON", async () => {
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      return { output: PASSING_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        mode: "embedded",
      },
    } as any);

    expect(sendCalls).toHaveLength(1);
    expect(result.output).toBe(PASSING_RESPONSE);
  });

  test("accumulates cost from both initial and retry calls", async () => {
    let callCount = 0;
    const mockSend = mock(async (_prompt: string) => {
      callCount++;
      return {
        output: callCount === 1 ? "not json" : PASSING_RESPONSE,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
        estimatedCostUsd: 0.5,
      };
    });

    const { adversarialReviewOp } = await import("../../../src/operations/adversarial-review");
    const result = await adversarialReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        adversarialConfig: ADVERSARIAL_CONFIG,
        mode: "embedded",
      },
    } as any);

    expect(result.estimatedCostUsd).toBe(1.0);
  });
});
