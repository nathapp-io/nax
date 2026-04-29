/**
 * Tests for PROMPT-001: autofix session continuity wiring.
 *
 * Verifies that runAgentRectification uses the ADR-019 session lifecycle
 * (openSession + runAsSession + closeSession) and passes the correct
 * sessionRole for rectification.
 */

import { describe, expect, mock, test } from "bun:test";
import { computeAcpHandle } from "../../../../src/agents/acp/adapter";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../../src/review/types";
import { makeMockRuntime } from "../../../helpers/runtime";
import { makeSessionManager } from "../../../helpers/mock-session-manager";
import type { SessionHandle, TurnResult } from "../../../../src/agents/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const WORKDIR = "/tmp/test-wd";
const FEATURE = "my-feature";
const STORY_ID = "US-001";

function makeFailedCheck(check = "lint"): ReviewCheckResult {
  return {
    check: check as ReviewCheckResult["check"],
    success: false,
    command: `${check}-cmd`,
    exitCode: 1,
    output: `${check} error output`,
    durationMs: 100,
  };
}

function makeCtxWithAgent(
  runAsSessionFn: (prompt: string) => Promise<TurnResult>,
  autofixMaxAttempts = 1,
): PipelineContext {
  const capturedPrompts: string[] = [];
  const capturedSessionRoles: string[] = [];

  const sessionManager = makeSessionManager({
    openSession: mock(async () => ({ id: "mock-session", agentName: "claude" } as SessionHandle)),
    closeSession: mock(async () => {}),
  });

  const agentManager = {
    getDefault: () => "claude",
    runAsSession: mock(async (_agentName: string, _handle: SessionHandle, prompt: string, options: Record<string, unknown>) => {
      capturedPrompts.push(prompt);
      capturedSessionRoles.push(options.sessionRole as string);
      return await runAsSessionFn(prompt);
    }),
    isUnavailable: () => false,
    markUnavailable: () => {},
    reset: () => {},
    validateCredentials: async () => {},
  } as any;

  const runtime = makeMockRuntime({ agentManager, sessionManager });

  return {
    config: {
      ...DEFAULT_CONFIG,
      quality: {
        ...DEFAULT_CONFIG.quality,
        autofix: { enabled: true, maxAttempts: autofixMaxAttempts },
      },
    } as any,
    prd: { feature: FEATURE, stories: [] } as any,
    story: { id: STORY_ID, title: "t", status: "in-progress", acceptanceCriteria: [] } as any,
    stories: [],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: WORKDIR,
    projectDir: WORKDIR,
    hooks: {} as any,
    reviewResult: {
      success: false,
      checks: [makeFailedCheck("lint")],
      totalDurationMs: 100,
    },
    agentManager,
    runtime,
  } as PipelineContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("autofix session wiring (PROMPT-001)", () => {
  test("openSession receives role='implementer' for rectification session", async () => {
    const ctx = makeCtxWithAgent(async () => ({
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    }), 1);

    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => true;

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
    }

    expect(ctx.runtime.sessionManager.openSession).toHaveBeenCalledTimes(1);
    const openOpts = (ctx.runtime.sessionManager.openSession.mock.calls as unknown[][])[0][1] as Record<string, unknown>;
    expect(openOpts.role).toBe("implementer");
  });

  test("runAsSession receives sessionRole='implementer'", async () => {
    const ctx = makeCtxWithAgent(async () => ({
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      internalRoundTrips: 0,
    }), 1);

    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => true;

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
    }

    expect(ctx.agentManager.runAsSession).toHaveBeenCalledTimes(1);
    const runOpts = (ctx.agentManager.runAsSession.mock.calls as unknown[][])[0][3] as Record<string, unknown>;
    expect(runOpts.sessionRole).toBe("implementer");
  });

  test("attempt 2 uses continuation prompt when session is confirmed open", async () => {
    let attemptCount = 0;
    const ctx = makeCtxWithAgent(async () => {
      attemptCount++;
      return {
        output: `attempt ${attemptCount} output`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      };
    }, 2);

    ctx.reviewResult = { success: false, checks: [makeFailedCheck("lint")], totalDurationMs: 100 };

    const saved = { recheckReview: _autofixDeps.recheckReview, captureGitRef: _autofixDeps.captureGitRef };
    _autofixDeps.recheckReview = async () => false;
    // Different refs each time so no-op detection doesn't fire
    let refCounter = 0;
    _autofixDeps.captureGitRef = async () => `ref-${refCounter++}`;

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
      _autofixDeps.captureGitRef = saved.captureGitRef;
    }

    expect(ctx.agentManager.runAsSession).toHaveBeenCalledTimes(2);

    const firstPrompt = (ctx.agentManager.runAsSession.mock.calls as unknown[][])[0][2] as string;
    const secondPrompt = (ctx.agentManager.runAsSession.mock.calls as unknown[][])[1][2] as string;

    // First prompt is the full rectification prompt (not a continuation opener)
    expect(firstPrompt).not.toContain("Your previous fix attempt did not resolve all issues");
    // Second prompt is the continuation — opens with the follow-up signal
    expect(secondPrompt).toContain("Your previous fix attempt did not resolve all issues");
    // Continuation does not include the story section header present in the full prompt
    expect(secondPrompt).not.toMatch(/^## Story/m);
  });

  test("sessionRole is 'implementer' on all attempts", async () => {
    let attemptCount = 0;
    const ctx = makeCtxWithAgent(async () => {
      attemptCount++;
      return {
        output: `attempt ${attemptCount} output`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 0,
      };
    }, 2);

    ctx.reviewResult = { success: false, checks: [makeFailedCheck("lint")], totalDurationMs: 100 };

    const saved = { recheckReview: _autofixDeps.recheckReview, captureGitRef: _autofixDeps.captureGitRef };
    _autofixDeps.recheckReview = async () => false;
    let refCounter = 0;
    _autofixDeps.captureGitRef = async () => `ref-${refCounter++}`;

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
      _autofixDeps.captureGitRef = saved.captureGitRef;
    }

    for (const call of ctx.agentManager.runAsSession.mock.calls as unknown[][]) {
      const opts = call[3] as Record<string, unknown>;
      expect(opts.sessionRole).toBe("implementer");
    }
  });
});
