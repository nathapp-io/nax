/**
 * Unit tests for the JSON retry logic in src/review/adversarial.ts
 *
 * ADR-019: Retry moved inside adversarialReviewOp.hopBody. runAdversarialReview
 * calls callOp once; retry is invisible at this level. Tests verify
 * observable outcomes (fail-open, looksLikeFail, success) and logging.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assertDefined, makeAdversarialOutput, makeMockAgentManager, makeMockRuntime, makeSpawn } from "@test/helpers";
import * as loggerModule from "@/logger";
import { Logger } from "@/logger";
import { _adversarialDeps, runAdversarialReview } from "@/review/adversarial";
import { _diffUtilsDeps } from "@/review/diff-utils";
import type { AdversarialReviewConfig, SemanticStory } from "@/review/types";

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
  _diffUtilsDeps.spawn = makeSpawn(() => statContent).spawn;
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
    _adversarialDeps.callOp = mock(async () => makeAdversarialOutput({ passed: true, findings: [] }));
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
    _adversarialDeps.callOp = mock(async () => makeAdversarialOutput({ passed: true, findings: [], failOpen: true }));
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
    _adversarialDeps.callOp = mock(async () =>
      makeAdversarialOutput({ passed: false, findings: [], looksLikeFail: true }),
    );
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
    _adversarialDeps.callOp = mock(async () =>
      makeAdversarialOutput({
        passed: false,
        findings: [
          {
            severity: "error",
            file: "src/log.ts",
            line: 1,
            issue: "Bug",
            suggestion: "Fix",
            acQuote: "can log in",
            acIndex: 1,
            verifiedBy: { file: "src/log.ts", observed: "bug stub" },
          },
        ],
      }),
    );
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
    const findings = result.findings;
    assertDefined(findings, "result.findings");
    expect(findings).toHaveLength(1);
    const firstFinding = findings[0];
    assertDefined(firstFinding, "result.findings[0]");
    expect(firstFinding.source).toBe("adversarial-review");
  });

  test("passes resolver-derived testGlobs and refExcludePatterns to callOp input", async () => {
    const callOpMock = mock(async () => makeAdversarialOutput({ passed: true, findings: [] }));
    _adversarialDeps.callOp = callOpMock;

    const agentManager = makeAgentManager(PASSING_RESPONSE);
    const runtime = makeMockRuntime({ agentManager });

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc123",
      story: STORY,
      adversarialConfig: { ...ADVERSARIAL_CONFIG, excludePatterns: undefined },
      agentManager,
      runtime,
    });

    expect(callOpMock).toHaveBeenCalledTimes(1);
    const input = (callOpMock.mock.calls[0] as unknown[])[2] as {
      testGlobs?: readonly string[];
      refExcludePatterns?: readonly string[];
    };

    expect((input.testGlobs ?? []).length).toBeGreaterThan(0);
    expect((input.testGlobs ?? []).some((glob) => glob.includes(".test.ts"))).toBe(true);

    expect((input.refExcludePatterns ?? []).length).toBeGreaterThan(0);
    expect(input.refExcludePatterns).toContain(":!*.test.ts");
    expect(input.refExcludePatterns).toContain(":!*.spec.ts");
    expect(input.refExcludePatterns).toContain(":!.nax/");
    expect(input.refExcludePatterns).toContain(":!.nax-pids");
  });

  test("returns fail-open when callOp throws", async () => {
    _adversarialDeps.callOp = mock(async () => {
      throw new Error("LLM call failed");
    });
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
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    _adversarialDeps.callOp = mock(async () => makeAdversarialOutput({ passed: true, findings: [] }));
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
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    _adversarialDeps.callOp = mock(async () => makeAdversarialOutput({ passed: true, findings: [], failOpen: true }));
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
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    _adversarialDeps.callOp = mock(async () =>
      makeAdversarialOutput({ passed: false, findings: [], looksLikeFail: true }),
    );
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
    loggerSpy = spyOn(loggerModule, "getSafeLogger").mockReturnValue(logger);

    _adversarialDeps.callOp = mock(async () => makeAdversarialOutput({ passed: true, findings: [] }));
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
