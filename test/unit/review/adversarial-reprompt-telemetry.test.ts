/**
 * Integration tests for review-reprompt-on-drop telemetry event.
 *
 * AC4: When a mocked adversarial run triggers a reprompt (first response has only
 *      dropped blockers with acIndex:0, second response is grounded), then
 *      adversarial session send count equals 2 and exactly one
 *      review-reprompt-on-drop event is emitted.
 * AC5: The final review result is either passed:true or passed:false with at
 *      least one blocking finding visible in output findings.
 * AC6: When reprompt second turn fails JSON parse, exactly one telemetry event
 *      is emitted with repromptOutcome:"parse-failed".
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IAgentManager } from "../../../src/agents";
import { _diffUtilsDeps } from "../../../src/review/diff-utils";
import { runAdversarialReview } from "../../../src/review/adversarial";
import type { AdversarialReviewConfig, SemanticStory } from "../../../src/review/types";
import { makeAgentAdapter, makeMockRuntime, makeMockAgentManager } from "../../helpers";
import type { NaxRuntime } from "../../../src/runtime";
import type { ReviewRepromptEvent } from "../../../src/runtime/dispatch-events";

const STORY: SemanticStory = {
  id: "STORY-REP-01",
  title: "Reprompt telemetry test",
  description: "Test reprompt event emission",
  acceptanceCriteria: [
    "AC1: auth login must not allow SQL injection attacks",
    "AC2: handler must not throw unhandled exceptions",
  ],
};

const ADVERSARIAL_CONFIG: AdversarialReviewConfig = {
  model: "balanced",
  diffMode: "ref",
  rules: [],
  timeoutMs: 60_000,
  parallel: false,
  maxConcurrentSessions: 2,
  acRegroundOnDrop: true,
};

function makeDroppedFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "error",
    category: "security",
    file: "src/auth.ts",
    line: 1,
    issue: "SQL injection via rawQuery",
    suggestion: "Use parameterized queries",
    // missing acQuote and acIndex — will be dropped by filterByAcQuote
    ...overrides,
  };
}

function makeAcceptedFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    severity: "error",
    category: "security",
    file: "src/auth.ts",
    line: 1,
    issue: "SQL injection confirmed",
    suggestion: "Use parameterized queries",
    acQuote: "auth login must not allow SQL injection attacks",
    acIndex: 1,
    verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery(u + p)" },
    ...overrides,
  };
}

const STAT_OUTPUT = "src/auth.ts | 5 +++++\n 1 file changed, 5 insertions(+)";

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

function makeAgentManager(llmResponse: string): IAgentManager {
  return makeMockAgentManager({
    getDefaultAgent: "claude",
    getAgentFn: () => makeAgentAdapter(),
    runWithFallbackFn: async (req) => {
      const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
    },
    runAsSessionFn: mock(async () => ({
      output: llmResponse,
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
      estimatedCostUsd: 0.001,
      internalRoundTrips: 0,
    })),
  });
}

describe("review-reprompt-on-drop telemetry integration", () => {
  let createdRuntimes: NaxRuntime[] = [];
  let origIsGitRefValid: typeof _diffUtilsDeps.isGitRefValid;
  let origGetMergeBase: typeof _diffUtilsDeps.getMergeBase;
  let origSpawn: typeof _diffUtilsDeps.spawn;

  beforeEach(() => {
    origIsGitRefValid = _diffUtilsDeps.isGitRefValid;
    origGetMergeBase = _diffUtilsDeps.getMergeBase;
    origSpawn = _diffUtilsDeps.spawn;
    _diffUtilsDeps.isGitRefValid = mock(async () => true);
    _diffUtilsDeps.getMergeBase = mock(async () => undefined);
    _diffUtilsDeps.spawn = makeSpawnMock(STAT_OUTPUT);
  });

  afterEach(async () => {
    _diffUtilsDeps.isGitRefValid = origIsGitRefValid;
    _diffUtilsDeps.getMergeBase = origGetMergeBase;
    _diffUtilsDeps.spawn = origSpawn;
    await Promise.allSettled(createdRuntimes.map((r) => r.close()));
    createdRuntimes.length = 0;
  });

  test("AC4: reprompt triggers exactly one review-reprompt-on-drop event", async () => {
    mkdirSync(join("/tmp", "wd", "src"), { recursive: true });
    writeFileSync(join("/tmp", "wd", "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

    let sessionSendCount = 0;
    const firstTurn = JSON.stringify({
      passed: false,
      findings: [makeDroppedFinding()],
    });
    const secondTurn = JSON.stringify({
      passed: true,
      findings: [],
    });

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: () => makeAgentAdapter(),
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: mock(async () => {
        sessionSendCount += 1;
        return {
          output: sessionSendCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          estimatedCostUsd: sessionSendCount === 1 ? 0.001 : 0.002,
          internalRoundTrips: 0,
        };
      }),
    });

    const repromptEvents: ReviewRepromptEvent[] = [];
    const runtime = makeMockRuntime({ agentManager });
    createdRuntimes.push(runtime);
    runtime.dispatchEvents.onReviewReprompt((e) => repromptEvents.push(e));

    await runAdversarialReview({
      workdir: "/tmp/wd",
      storyGitRef: "abc1234",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(sessionSendCount).toBe(2);
    expect(repromptEvents).toHaveLength(1);
    expect(repromptEvents[0].kind).toBe("review-reprompt-on-drop");
    expect(repromptEvents[0].storyId).toBe(STORY.id);
    expect(repromptEvents[0].reviewer).toBe("adversarial");
    expect(repromptEvents[0].dropCount).toBe(1);
  });

  test("AC6: second turn invalid JSON → repromptOutcome:parse-failed", async () => {
    mkdirSync(join("/tmp", "wd2", "src"), { recursive: true });
    writeFileSync(join("/tmp", "wd2", "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

    let sessionSendCount = 0;
    const firstTurn = JSON.stringify({
      passed: false,
      findings: [makeDroppedFinding()],
    });
    const secondTurn = "not valid json at all";

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: () => makeAgentAdapter(),
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: mock(async () => {
        sessionSendCount += 1;
        return {
          output: sessionSendCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          estimatedCostUsd: sessionSendCount === 1 ? 0.001 : 0.002,
          internalRoundTrips: 0,
        };
      }),
    });

    const repromptEvents: ReviewRepromptEvent[] = [];
    const runtime = makeMockRuntime({ agentManager });
    createdRuntimes.push(runtime);
    runtime.dispatchEvents.onReviewReprompt((e) => repromptEvents.push(e));

    await runAdversarialReview({
      workdir: "/tmp/wd2",
      storyGitRef: "abc1234",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(sessionSendCount).toBe(2);
    expect(repromptEvents).toHaveLength(1);
    expect(repromptEvents[0].repromptOutcome).toBe("parse-failed");
  });

  test("AC5: second turn with surviving blocking findings → passed:false with findings in output", async () => {
    mkdirSync(join("/tmp", "wd4", "src"), { recursive: true });
    writeFileSync(join("/tmp", "wd4", "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

    let sessionSendCount = 0;
    const firstTurn = JSON.stringify({
      passed: false,
      findings: [makeDroppedFinding()],
    });
    const secondTurn = JSON.stringify({
      passed: false,
      findings: [
        {
          severity: "error",
          category: "security",
          file: "src/auth.ts",
          line: 1,
          issue: "SQL injection not mitigated",
          suggestion: "Use parameterized queries",
          acQuote: "auth login must not allow SQL injection attacks",
          acIndex: 1,
          verifiedBy: { file: "src/auth.ts", line: 1, observed: "db.rawQuery(u + p)" },
        },
      ],
    });

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: () => makeAgentAdapter(),
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: mock(async () => {
        sessionSendCount += 1;
        return {
          output: sessionSendCount === 1 ? firstTurn : secondTurn,
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          estimatedCostUsd: sessionSendCount === 1 ? 0.001 : 0.002,
          internalRoundTrips: 0,
        };
      }),
    });

    const repromptEvents: ReviewRepromptEvent[] = [];
    const runtime = makeMockRuntime({ agentManager });
    createdRuntimes.push(runtime);
    runtime.dispatchEvents.onReviewReprompt((e) => repromptEvents.push(e));

    const result = await runAdversarialReview({
      workdir: "/tmp/wd4",
      storyGitRef: "abc1234",
      story: STORY,
      adversarialConfig: ADVERSARIAL_CONFIG,
      agentManager,
      runtime,
    });

    expect(sessionSendCount).toBe(2);
    expect(repromptEvents).toHaveLength(1);
    expect(repromptEvents[0].repromptOutcome).toBe("recovered-blocking");
    expect(result.success === true || (result.success === false && result.findings && result.findings.length > 0)).toBe(true);
  });

  test("no reprompt: acRegroundOnDrop === false → zero events", async () => {
    mkdirSync(join("/tmp", "wd3", "src"), { recursive: true });
    writeFileSync(join("/tmp", "wd3", "src", "auth.ts"), "function login(u, p) { return db.rawQuery(u + p); }\n");

    let sessionSendCount = 0;
    const firstTurn = JSON.stringify({
      passed: false,
      findings: [makeDroppedFinding()],
    });

    const agentManager = makeMockAgentManager({
      getDefaultAgent: "claude",
      getAgentFn: () => makeAgentAdapter(),
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: mock(async () => {
        sessionSendCount += 1;
        return {
          output: firstTurn,
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
          estimatedCostUsd: 0.001,
          internalRoundTrips: 0,
        };
      }),
    });

    const repromptEvents: ReviewRepromptEvent[] = [];
    const runtime = makeMockRuntime({ agentManager });
    createdRuntimes.push(runtime);
    runtime.dispatchEvents.onReviewReprompt((e) => repromptEvents.push(e));

    await runAdversarialReview({
      workdir: "/tmp/wd3",
      storyGitRef: "abc1234",
      story: STORY,
      adversarialConfig: { ...ADVERSARIAL_CONFIG, acRegroundOnDrop: false },
      agentManager,
      runtime,
    });

    expect(sessionSendCount).toBe(1);
    expect(repromptEvents).toHaveLength(0);
  });
});