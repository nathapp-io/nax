/**
 * Unit tests for the JSON retry logic in src/review/semantic.ts
 *
 * ADR-019: Retry moved inside semanticReviewOp.hopBody. runSemanticReview
 * calls callOp once; retry is invisible at this level. Tests verify
 * observable outcomes (fail-open, looksLikeFail, success) and logging.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  makeMockAgentManager,
  makeMockRuntime,
  makeSemanticOutput,
  makeSessionManager,
  makeSpawn,
  makeTestRuntime,
  withTempDir,
} from "@test/helpers";
import type { AgentRunRequest } from "@/agents";
import * as loggerModule from "@/logger";
import { Logger } from "@/logger";
import { callOp, semanticReviewOp } from "@/operations";
import type { SemanticReviewInput } from "@/operations/semantic-review";
import type { HopBodyContext } from "@/operations/types";
import { _diffUtilsDeps } from "@/review/diff-utils";
import type { ReviewAuditDecision } from "@/review/review-audit";
import type { SemanticStory } from "@/review/semantic";
import { _semanticDeps, runSemanticReview } from "@/review/semantic";
import type { SemanticReviewConfig } from "@/review/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const STORY: SemanticStory = {
  id: "US-002",
  title: "Implement semantic review runner",
  description: "Create src/review/semantic.ts with runSemanticReview()",
  acceptanceCriteria: ["runSemanticReview() accepts workdir, storyGitRef, story, semanticConfig, and modelResolver"],
};

const DEFAULT_SEMANTIC_CONFIG: SemanticReviewConfig = {
  model: "balanced",
  diffMode: "embedded",
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 60_000,
  substantiation: { requote: true, maxRequotes: 5 },
  excludePatterns: [":!test/", ":!*.test.ts"],
};

const PASSING_LLM_RESPONSE = JSON.stringify({ passed: true, findings: [] });

/** Drive the run request's optional executeHop callback, failing loudly if absent. */
async function runPrimaryHop(req: AgentRunRequest) {
  assertDefined(req.executeHop, "AgentRunRequest.executeHop");
  return req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
}

/** Run semanticReviewOp's optional hopBody("initial prompt") turn, failing loudly if absent. */
async function hopBodyInitial(ctx: HopBodyContext<SemanticReviewInput>) {
  assertDefined(semanticReviewOp.hopBody, "semanticReviewOp.hopBody");
  return semanticReviewOp.hopBody("initial prompt", ctx);
}

// ─── Logger mock helpers ─────────────────────────────────────────────────────

interface LogCall {
  stage: string;
  message: string;
  data?: Record<string, unknown>;
}

function makeLogger(): Logger & MockLoggerExtras {
  const infoCalls: LogCall[] = [];
  const warnCalls: LogCall[] = [];
  const logger = new Logger({ level: "silent" });
  logger.info = ((stage: string, message: string, data?: Record<string, unknown>) => {
    infoCalls.push({ stage, message, data });
  }) as typeof logger.info;
  logger.warn = ((stage: string, message: string, data?: Record<string, unknown>) => {
    warnCalls.push({ stage, message, data });
  }) as typeof logger.warn;
  return Object.assign(logger, { infoCalls, warnCalls });
}

interface MockLoggerExtras {
  infoCalls: LogCall[];
  warnCalls: LogCall[];
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
  _diffUtilsDeps.spawn = makeSpawn(() => "src/foo.ts | 5 +++++\n 1 file changed, 5 insertions(+)").spawn;
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

describe("runSemanticReview — JSON retry outcomes", () => {
  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(restoreAllDeps);

  test("returns success when callOp returns valid findings", async () => {
    _semanticDeps.callOp = mock(async () => makeSemanticOutput({ passed: true, findings: [] }));
    const auditCalls: ReviewAuditDecision[] = [];
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({
      agentManager,
      reviewAuditor: {
        recordDispatch() {},
        recordDecision: (entry) => auditCalls.push(entry),
        getAdvisoryFindings: () => [],
        async flush() {},
      },
    });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Semantic review passed");
    expect(auditCalls).toHaveLength(1);
    const decision = auditCalls[0];
    assertDefined(decision, "review audit decision");
    expect(decision.reviewer).toBe("semantic");
    expect(decision.parsed).toBe(true);
    expect(decision.passed).toBe(true);
  });

  test("returns fail-open when callOp returns failOpen", async () => {
    _semanticDeps.callOp = mock(async () => makeSemanticOutput({ passed: true, findings: [], failOpen: true }));
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.output).toContain("fail-open");
  });

  test("returns failure when callOp returns looksLikeFail", async () => {
    _semanticDeps.callOp = mock(async () => makeSemanticOutput({ passed: false, findings: [], looksLikeFail: true }));
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("passed:false");
  });

  test("returns failure with blocking findings when callOp returns findings", async () => {
    _semanticDeps.callOp = mock(async () =>
      makeSemanticOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/workdir.ts",
            line: 1,
            issue: "Bug",
            suggestion: "Fix",
            acQuote: "accepts workdir, storyGitRef",
            acIndex: 1,
          },
        ],
      }),
    );
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(false);
    expect(result.findings).toHaveLength(1);
    const findings = result.findings;
    assertDefined(findings, "semantic review findings");
    expect(findings[0].source).toBe("semantic-review");
  });

  test("returns fail-open when callOp throws", async () => {
    _semanticDeps.callOp = mock(async () => {
      throw new Error("LLM call failed");
    });
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    const result = await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    expect(result.success).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.output).toContain("skipped");
  });
});

describe("runSemanticReview — logging", () => {
  let loggerSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    saveAllDeps();
    setupHappyPathDeps();
  });

  afterEach(() => {
    restoreAllDeps();
    loggerSpy?.mockRestore();
  });

  test("logs info 'Semantic review passed' on success", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    _semanticDeps.callOp = mock(async () => makeSemanticOutput({ passed: true, findings: [] }));
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    const successLog = logger.infoCalls.find((c) => c.message.includes("Semantic review passed"));
    expect(successLog).toBeDefined();
    expect(successLog?.stage).toBe("review");
  });

  test("logs warn 'Retry exhausted — fail-open' when callOp returns failOpen", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    _semanticDeps.callOp = mock(async () => makeSemanticOutput({ passed: true, findings: [], failOpen: true }));
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    const exhaustLog = logger.warnCalls.find((c) => c.message.includes("Retry exhausted"));
    expect(exhaustLog).toBeDefined();
    expect(exhaustLog?.stage).toBe("semantic");
  });

  test("logs warn 'LLM returned truncated JSON' when callOp returns looksLikeFail", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    _semanticDeps.callOp = mock(async () => makeSemanticOutput({ passed: false, findings: [], looksLikeFail: true }));
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    const truncatedLog = logger.warnCalls.find((c) => c.message.includes("truncated JSON"));
    expect(truncatedLog).toBeDefined();
    expect(truncatedLog?.stage).toBe("semantic");
  });

  test("does not log 'Retry exhausted' when callOp returns success", async () => {
    const logger = makeLogger();
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    _semanticDeps.callOp = mock(async () => makeSemanticOutput({ passed: true, findings: [] }));
    const agentManager = makeAgentManager(PASSING_LLM_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runSemanticReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      semanticConfig: DEFAULT_SEMANTIC_CONFIG,
      agentManager,
      runtime,
    });

    const retryLog = logger.warnCalls.find((c) => c.message.includes("Retry exhausted"));
    expect(retryLog).toBeUndefined();
  });
});

describe("semanticReviewOp — retry behaviour (callOp integration)", () => {
  test("calls runAsSession twice when first response is unparseable", async () => {
    let sessionCallCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await runPrimaryHop(req);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        sessionCallCount++;
        return {
          output: sessionCallCount === 1 ? "not json at all" : PASSING_LLM_RESPONSE,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.001,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
      semanticReviewOp,
      { workdir: "/tmp/wd", story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
    );

    expect(sessionCallCount).toBe(2);
  });

  test("calls runAsSession once when first response is valid JSON", async () => {
    let sessionCallCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await runPrimaryHop(req);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        sessionCallCount++;
        return {
          output: PASSING_LLM_RESPONSE,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.001,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
      semanticReviewOp,
      { workdir: "/tmp/wd", story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
    );

    expect(sessionCallCount).toBe(1);
  });

  test("fires multiple runAsSession calls when first N responses are unparseable", async () => {
    let sessionCallCount = 0;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req: AgentRunRequest) => {
        const hopResult = await runPrimaryHop(req);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => {
        sessionCallCount++;
        return {
          output: sessionCallCount < 2 ? "not json" : PASSING_LLM_RESPONSE,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.5,
          internalRoundTrips: 0,
        };
      },
    });
    const sessionManager = makeSessionManager();
    const runtime = makeTestRuntime({ agentManager, sessionManager });

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
      semanticReviewOp,
      { workdir: "/tmp/wd", story: STORY, semanticConfig: DEFAULT_SEMANTIC_CONFIG, mode: "embedded" },
    );

    expect(sessionCallCount).toBeGreaterThanOrEqual(2);
  });
});

describe("semanticReviewOp.hopBody — same-session requote", () => {
  test("recovers a blocking finding when requote returns a verbatim matching excerpt", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {\n  return 42;\n}\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/foo.ts",
            line: 1,
            issue: "Missing proof",
            suggestion: "Quote the file",
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "this description does not match disk",
            },
          },
        ],
      });
      const requote = JSON.stringify({
        file: "src/foo.ts",
        line: 1,
        observed: "export function foo() {\n  return 42;\n}",
      });
      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? initial : requote,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      });

      const result = await hopBodyInitial({
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
          mode: "ref",
        },
      });

      const parsed = JSON.parse(result.output);
      expect(callCount).toBe(2);
      expect(parsed.findings[0].severity).toBe("error");
      expect(parsed.findings[0].verifiedBy.observed).toContain("return 42");
    });
  });

  test("downgrades when requote response is invalid JSON", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/foo.ts",
            line: 1,
            issue: "Missing proof",
            suggestion: "Quote the file",
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "this description does not match disk",
            },
          },
        ],
      });
      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? initial : "not json",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      });

      const result = await hopBodyInitial({
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
          mode: "ref",
        },
      });

      const parsed = JSON.parse(result.output);
      expect(callCount).toBe(2);
      expect(parsed.findings[0].severity).toBe("unverifiable");
    });
  });
});

describe("semanticReviewOp.hopBody — requote recovery regressions", () => {
  test("accepts salvageable single-finding full-review requote JSON", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {\n  return 42;\n}\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/foo.ts",
            line: 1,
            issue: "Missing proof",
            suggestion: "Quote the file",
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "does not match",
            },
          },
        ],
      });
      const requote = JSON.stringify({
        passed: true,
        findings: [
          {
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "export function foo() {\n  return 42;\n}",
            },
          },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? initial : requote,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      });

      const result = await hopBodyInitial({
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
          mode: "ref",
        },
      });

      const parsed = JSON.parse(result.output);
      expect(callCount).toBe(2);
      expect(parsed.findings[0].verifiedBy.observed).toContain("return 42");
    });
  });

  test("sets passed true when requote fails and the only blocking finding is downgraded", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/foo.ts",
            line: 1,
            issue: "Missing proof",
            suggestion: "Quote the file",
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "does not match",
            },
          },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? initial : "not json",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      });

      const result = await hopBodyInitial({
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
          mode: "ref",
        },
      });

      const parsed = JSON.parse(result.output);
      expect(callCount).toBe(2);
      expect(parsed.findings[0].severity).toBe("unverifiable");
      expect(parsed.passed).toBe(true);
    });
  });

  test("keeps passed false when another blocking finding remains after requote downgrade", async () => {
    await withTempDir(async (workdir) => {
      mkdirSync(join(workdir, "src"), { recursive: true });
      writeFileSync(join(workdir, "src/foo.ts"), "export function foo() {}\n");

      const initial = JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/foo.ts",
            line: 1,
            issue: "Missing proof",
            suggestion: "Quote the file",
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "does not match",
            },
          },
          {
            severity: "error",
            file: "src/foo.ts",
            line: 1,
            issue: "Real blocking issue",
            suggestion: "Fix bug",
            verifiedBy: {
              file: "src/foo.ts",
              line: 1,
              observed: "export function foo() {}",
            },
          },
        ],
      });

      let callCount = 0;
      const mockSend = mock(async () => {
        callCount += 1;
        return {
          output: callCount === 1 ? initial : "not json",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      });

      const result = await hopBodyInitial({
        send: mockSend,
        sendWithParseRetry: mockSend,
        input: {
          workdir,
          story: STORY,
          semanticConfig: { ...DEFAULT_SEMANTIC_CONFIG, diffMode: "ref" },
          mode: "ref",
        },
      });

      const parsed = JSON.parse(result.output);
      expect(callCount).toBe(2);
      expect(parsed.findings[0].severity).toBe("unverifiable");
      expect(parsed.findings[1].severity).toBe("error");
      expect(parsed.passed).toBe(false);
    });
  });
});
