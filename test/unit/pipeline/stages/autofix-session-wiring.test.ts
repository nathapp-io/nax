/**
 * Tests for PROMPT-001: autofix session continuity wiring.
 *
 * Verifies that runAgentRectification passes the correct acpSessionName and
 * keepSessionOpen values to agent.run(), and that continuation prompts are
 * used on retry when the session is confirmed open.
 */

import { describe, expect, mock, test } from "bun:test";
import { buildSessionName } from "../../../../src/agents/acp/adapter";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { _autofixDeps } from "../../../../src/pipeline/stages/autofix";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { ReviewCheckResult } from "../../../../src/review/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  mockAgent: { run: ReturnType<typeof mock> },
  autofixMaxAttempts = 1,
): PipelineContext {
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
    agentGetFn: () => mockAgent as any,
  } as PipelineContext;
}

function makeMockAgent(succeed = true) {
  return {
    run: mock(async () => ({
      success: succeed,
      output: "",
      exitCode: succeed ? 0 : 1,
      durationMs: 100,
      estimatedCost: 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("autofix session wiring (PROMPT-001)", () => {
  test("agent.run() receives acpSessionName matching buildSessionName(..., 'implementer')", async () => {
    const agent = makeMockAgent(true);
    const ctx = makeCtxWithAgent(agent, 1);

    const saved = {
      recheckReview: _autofixDeps.recheckReview,
    };
    _autofixDeps.recheckReview = async () => true;

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
    }

    expect(agent.run).toHaveBeenCalledTimes(1);
    const runOpts = (agent.run.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    const expected = buildSessionName(WORKDIR, FEATURE, STORY_ID, "implementer");
    expect(runOpts.acpSessionName).toBe(expected);
  });

  test("keepSessionOpen: false when maxAttempts=1 (single attempt is last attempt)", async () => {
    const agent = makeMockAgent(true);
    const ctx = makeCtxWithAgent(agent, 1);

    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => true;

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
    }

    expect(agent.run).toHaveBeenCalledTimes(1);
    const runOpts = (agent.run.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect(runOpts.keepSessionOpen).toBe(false);
  });

  test("keepSessionOpen: true on non-last attempt, false on last attempt", async () => {
    const agent = makeMockAgent(false); // always fail so loop runs maxAttempts
    const ctx = makeCtxWithAgent(agent, 2);
    // Update review result after each attempt to keep failing
    ctx.reviewResult = { success: false, checks: [makeFailedCheck("lint")], totalDurationMs: 100 };

    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false; // always fail

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
    }

    expect(agent.run).toHaveBeenCalledTimes(2);

    const firstCallOpts = (agent.run.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
    expect(firstCallOpts.keepSessionOpen).toBe(true); // attempt 0, not last

    const secondCallOpts = (agent.run.mock.calls as unknown[][])[1][0] as Record<string, unknown>;
    expect(secondCallOpts.keepSessionOpen).toBe(false); // attempt 1 == maxAttempts-1, is last
  });

  test("attempt 2 uses continuation prompt (shorter, no 'Story:' section header)", async () => {
    const agent = makeMockAgent(false);
    const ctx = makeCtxWithAgent(agent, 2);
    ctx.reviewResult = { success: false, checks: [makeFailedCheck("lint")], totalDurationMs: 100 };

    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false;

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
    }

    expect(agent.run).toHaveBeenCalledTimes(2);

    const firstPrompt = ((agent.run.mock.calls as unknown[][])[0][0] as Record<string, unknown>).prompt as string;
    const secondPrompt = ((agent.run.mock.calls as unknown[][])[1][0] as Record<string, unknown>).prompt as string;

    // First prompt is the full rectification prompt (not a continuation opener)
    expect(firstPrompt).not.toContain("Your previous fix attempt did not resolve all issues");
    // Second prompt is the continuation — opens with the follow-up signal
    expect(secondPrompt).toContain("Your previous fix attempt did not resolve all issues");
    // Continuation does not include the story section header present in the full prompt
    expect(secondPrompt).not.toMatch(/^## Story/m);
  });

  test("sessionRole is 'implementer' on all attempts", async () => {
    const agent = makeMockAgent(false);
    const ctx = makeCtxWithAgent(agent, 2);
    ctx.reviewResult = { success: false, checks: [makeFailedCheck("lint")], totalDurationMs: 100 };

    const saved = { recheckReview: _autofixDeps.recheckReview };
    _autofixDeps.recheckReview = async () => false;

    try {
      await _autofixDeps.runAgentRectification(ctx, undefined, undefined, WORKDIR);
    } finally {
      _autofixDeps.recheckReview = saved.recheckReview;
    }

    for (const call of agent.run.mock.calls as unknown[][]) {
      const opts = call[0] as Record<string, unknown>;
      expect(opts.sessionRole).toBe("implementer");
    }
  });
});
