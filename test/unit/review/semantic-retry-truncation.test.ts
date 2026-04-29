/**
 * Unit tests for truncation-aware condensed retry in src/review/semantic.ts
 *
 * ADR-019: Retry moved inside semanticReviewOp.hopBody. runSemanticReview
 * calls callOp once; retry is invisible at this level. Tests verify
 * hopBody prompt selection and truncation detection.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as loggerModule from "../../../src/logger";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { _semanticDeps, runSemanticReview } from "../../../src/review/semantic";
import type { SemanticStory } from "../../../src/review/semantic";
import type { SemanticReviewConfig } from "../../../src/review/types";
import { makeMockAgentManager } from "../../helpers";
import { makeMockRuntime } from "../../helpers/runtime";

// ─── Fixtures ────────────────────────────────────────────────────────────────

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
let origWriteReviewAudit: typeof _semanticDeps.writeReviewAudit;
let origCallOp: typeof _semanticDeps.callOp;

function saveAllDeps() {
  origSpawn = _diffUtilsDeps.spawn;
  origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
  origGetMergeBase = _diffUtilsDeps.getMergeBase;
  origWriteReviewAudit = _semanticDeps.writeReviewAudit;
  origCallOp = _semanticDeps.callOp;
}

function restoreAllDeps() {
  _diffUtilsDeps.spawn = origSpawn;
  _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
  _diffUtilsDeps.getMergeBase = origGetMergeBase;
  _semanticDeps.writeReviewAudit = origWriteReviewAudit;
  _semanticDeps.callOp = origCallOp;
}

function setupHappyPathDeps() {
  _diffUtilsDeps.isGitRefValid = mock(async () => true);
  _diffUtilsDeps.getMergeBase = mock(async () => undefined);
  _diffUtilsDeps.spawn = mock((_opts: unknown) => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)"));
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

describe("semanticReviewOp.hopBody — truncation-detected condensed retry", () => {
  test("uses condensed retry prompt when response length is at the ACP output cap", async () => {
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      if (sendCalls.length === 1) {
        return { output: AT_CAP_UNPARSEABLE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }
      return { output: PASSING_LLM_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { semanticReviewOp } = await import("../../../src/operations/semantic-review");
    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        semanticConfig: DEFAULT_SEMANTIC_CONFIG,
        mode: "embedded",
      },
    } as any);

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]).toContain("truncated");
  });

  test("uses standard retry prompt when response is short unparseable text (not at cap)", async () => {
    const nonJson = "here is my analysis: the code looks fine overall";
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      if (sendCalls.length === 1) {
        return { output: nonJson, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }
      return { output: PASSING_LLM_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { semanticReviewOp } = await import("../../../src/operations/semantic-review");
    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        semanticConfig: DEFAULT_SEMANTIC_CONFIG,
        mode: "embedded",
      },
    } as any);

    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]).not.toContain("truncated");
  });

  test("fires retry when response is at cap even before attempting parse", async () => {
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      if (sendCalls.length === 1) {
        return { output: AT_CAP_UNPARSEABLE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }
      return { output: PASSING_LLM_RESPONSE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { semanticReviewOp } = await import("../../../src/operations/semantic-review");
    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        semanticConfig: DEFAULT_SEMANTIC_CONFIG,
        mode: "embedded",
      },
    } as any);

    expect(sendCalls).toHaveLength(2);
  });

  test("succeeds when condensed retry returns valid JSON after cap-length truncation", async () => {
    const condensedResponse = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/foo.ts", line: 1, issue: "missing impl", suggestion: "add it" }],
    });
    const sendCalls: string[] = [];
    const mockSend = mock(async (prompt: string) => {
      sendCalls.push(prompt);
      if (sendCalls.length === 1) {
        return { output: AT_CAP_UNPARSEABLE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
      }
      return { output: condensedResponse, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { semanticReviewOp } = await import("../../../src/operations/semantic-review");
    const result = await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        semanticConfig: DEFAULT_SEMANTIC_CONFIG,
        mode: "embedded",
      },
    } as any);

    expect(result.output).toBe(condensedResponse);
  });
});

describe("semanticReviewOp.hopBody — truncation logging", () => {
  test("logs warn 'JSON parse retry — original response truncated' when response is at cap", async () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const mockSend = mock(async (_prompt: string) => {
      return { output: AT_CAP_UNPARSEABLE, tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { semanticReviewOp } = await import("../../../src/operations/semantic-review");
    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        semanticConfig: DEFAULT_SEMANTIC_CONFIG,
        mode: "embedded",
      },
    } as any);

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated"));
    expect(truncatedLog).toBeDefined();
    expect(truncatedLog?.stage).toBe("semantic");

    loggerSpy.mockRestore();
  });

  test("does not log truncation warning when response is short unparseable text (not at cap)", async () => {
    const logger = makeLogger();
    const loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger as never);

    const mockSend = mock(async (_prompt: string) => {
      return { output: "not json text", tokenUsage: { inputTokens: 0, outputTokens: 0 }, internalRoundTrips: 0 };
    });

    const { semanticReviewOp } = await import("../../../src/operations/semantic-review");
    await semanticReviewOp.hopBody!("initial prompt", {
      send: mockSend,
      input: {
        story: STORY,
        semanticConfig: DEFAULT_SEMANTIC_CONFIG,
        mode: "embedded",
      },
    } as any);

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated"));
    expect(truncatedLog).toBeUndefined();

    loggerSpy.mockRestore();
  });
});
