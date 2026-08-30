/**
 * decideStageAction — remaining routing branches not covered by
 * post-run-inspection.test.ts / post-run-isolation.test.ts:
 *
 * - self-verification explicit failure → escalate
 * - pauseReason with/without a live interaction chain, including notify failure
 * - TDD human-review pause with/without a live interaction chain
 * - TDD rollback failure (rollbackToRef throws)
 * - merge-conflict trigger: proceed vs abort
 * - non-TDD failure → escalate with failedPhases derivation
 * - non-TDD success → auto-commit + final continue log
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeInteractionChain, makeNaxConfig, makeTestContext } from "@test/helpers";
import type { AgentResult } from "@/agents/types";
import type { PostRunInspectionResult } from "@/execution/post-run";
import { _postRunDeps, decideStageAction } from "@/execution/post-run";
import type { InteractionRequest } from "@/interaction/types";
import { makeInspectionOpts, makePlanResult } from "./_post-run-fixtures";

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    exitCode: 0,
    output: "",
    rateLimited: false,
    durationMs: 10,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

function makeInspection(overrides: Partial<PostRunInspectionResult> = {}): PostRunInspectionResult {
  return {
    agentResult: makeAgentResult(),
    selfVerificationFailed: false,
    needsHumanReview: false,
    combinedOutput: "",
    ...overrides,
  };
}

describe("decideStageAction — self-verification explicit failure", () => {
  test("escalates with a lint/typecheck-failure reason", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({ success: true });
    const inspection = makeInspection({ selfVerificationFailed: true });

    const result = await decideStageAction(ctx, planResult, inspection, makeInspectionOpts());

    expect(result).toEqual({
      action: "escalate",
      reason: "Self-verification reported lint/typecheck failure",
    });
  });
});

describe("decideStageAction — pauseReason routing", () => {
  test("pauses with no interaction configured", async () => {
    const ctx = makeTestContext({ interaction: undefined });
    const planResult = makePlanResult({ success: true });
    const inspection = makeInspection({ pauseReason: "needs-approval" });

    const result = await decideStageAction(ctx, planResult, inspection, makeInspectionOpts());

    expect(result).toEqual({ action: "pause", reason: "needs-approval" });
  });

  test("sends a notify interaction and still pauses when the chain accepts it", async () => {
    const send = mock(async (_request: InteractionRequest) => undefined);
    const chain = makeInteractionChain({ send });
    const ctx = makeTestContext({ interaction: chain });
    const planResult = makePlanResult({ success: true });
    const inspection = makeInspection({ pauseReason: "needs-approval" });

    const result = await decideStageAction(ctx, planResult, inspection, makeInspectionOpts());

    expect(result).toEqual({ action: "pause", reason: "needs-approval" });
    expect(send).toHaveBeenCalledTimes(1);
    const sentRequest = send.mock.calls[0]?.[0];
    expect(sentRequest?.type).toBe("notify");
    expect(sentRequest?.summary).toContain(ctx.story.id);
  });

  test("still pauses when the interaction chain's send rejects", async () => {
    const send = mock(async () => {
      throw new Error("plugin unavailable");
    });
    const chain = makeInteractionChain({ send });
    const ctx = makeTestContext({ interaction: chain });
    const planResult = makePlanResult({ success: true });
    const inspection = makeInspection({ pauseReason: "needs-approval" });

    const result = await decideStageAction(ctx, planResult, inspection, makeInspectionOpts());

    expect(result).toEqual({ action: "pause", reason: "needs-approval" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("decideStageAction — TDD human-review pause", () => {
  test("pauses with a human-review reason and no interaction configured", async () => {
    const ctx = makeTestContext({ interaction: undefined });
    const planResult = makePlanResult({ success: false });
    const inspection = makeInspection({
      needsHumanReview: true,
      failureCategory: "session-failure",
    });
    const opts = makeInspectionOpts({ tddMode: { isLite: false, rollbackEnabled: false } });

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result).toEqual({ action: "pause", reason: "Human review needed: session-failure" });
  });

  test("sends a notify interaction for human review and still pauses when send rejects", async () => {
    const send = mock(async (_request: InteractionRequest) => {
      throw new Error("plugin down");
    });
    const chain = makeInteractionChain({ send });
    const ctx = makeTestContext({ interaction: chain });
    const planResult = makePlanResult({ success: false });
    const inspection = makeInspection({
      needsHumanReview: true,
      failureCategory: "session-failure",
    });
    const opts = makeInspectionOpts({ tddMode: { isLite: false, rollbackEnabled: false } });

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result).toEqual({ action: "pause", reason: "Human review needed: session-failure" });
    expect(send).toHaveBeenCalledTimes(1);
    const sentRequest = send.mock.calls[0]?.[0];
    expect(sentRequest?.summary).toContain("Human review needed");
  });
});

describe("decideStageAction — TDD rollback failure is swallowed and routing continues", () => {
  let origRollback: typeof _postRunDeps.rollbackToRef;

  beforeEach(() => {
    origRollback = _postRunDeps.rollbackToRef;
  });

  afterEach(() => {
    _postRunDeps.rollbackToRef = origRollback;
  });

  test("logs the rollback error and still routes via routeTddFailure", async () => {
    _postRunDeps.rollbackToRef = mock(async () => {
      throw new Error("git reset failed");
    });

    const ctx = makeTestContext();
    const planResult = makePlanResult({ success: false });
    const inspection = makeInspection({ failureCategory: "isolation-violation" });
    const opts = makeInspectionOpts({
      tddMode: { isLite: false, rollbackEnabled: true },
      initialRef: "abc123",
    });

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    // Rollback threw, was swallowed, and routing fell through to routeTddFailure —
    // isolation-violation routes to escalate regardless of rollback outcome.
    expect(result.action).toBe("escalate");
  });
});

describe("decideStageAction — merge-conflict trigger", () => {
  let origDetect: typeof _postRunDeps.detectMergeConflict;
  let origCheck: typeof _postRunDeps.checkMergeConflict;
  let origFailClose: typeof _postRunDeps.failAndClose;

  beforeEach(() => {
    origDetect = _postRunDeps.detectMergeConflict;
    origCheck = _postRunDeps.checkMergeConflict;
    origFailClose = _postRunDeps.failAndClose;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
  });

  afterEach(() => {
    _postRunDeps.detectMergeConflict = origDetect;
    _postRunDeps.checkMergeConflict = origCheck;
    _postRunDeps.failAndClose = origFailClose;
  });

  test("proceeds to the generic success path when the operator elects to continue", async () => {
    _postRunDeps.detectMergeConflict = mock(() => true) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.checkMergeConflict = mock(async () => true) as typeof _postRunDeps.checkMergeConflict;
    _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;

    const chain = makeInteractionChain();
    const ctx = makeTestContext({
      interaction: chain,
      config: makeNaxConfig({ interaction: { triggers: { "merge-conflict": true } } }),
    });
    const planResult = makePlanResult({ success: true });
    const inspection = makeInspection({ combinedOutput: "CONFLICT (content): Merge conflict in file.ts" });

    const result = await decideStageAction(ctx, planResult, inspection, makeInspectionOpts());

    expect(result).toEqual({ action: "continue" });
    expect(_postRunDeps.checkMergeConflict).toHaveBeenCalledTimes(1);
  });

  test("aborts the story when the operator elects to stop", async () => {
    _postRunDeps.detectMergeConflict = mock(() => true) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.checkMergeConflict = mock(async () => false) as typeof _postRunDeps.checkMergeConflict;

    const chain = makeInteractionChain();
    const ctx = makeTestContext({
      interaction: chain,
      config: makeNaxConfig({ interaction: { triggers: { "merge-conflict": true } } }),
    });
    const planResult = makePlanResult({ success: true });
    const inspection = makeInspection({ combinedOutput: "CONFLICT (content): Merge conflict in file.ts" });

    const result = await decideStageAction(ctx, planResult, inspection, makeInspectionOpts());

    expect(result).toEqual({ action: "fail", reason: "Merge conflict detected" });
    expect(_postRunDeps.failAndClose).not.toHaveBeenCalled();
  });
});

describe("decideStageAction — non-TDD failure escalation", () => {
  let origFailClose: typeof _postRunDeps.failAndClose;
  let origDetect: typeof _postRunDeps.detectMergeConflict;

  beforeEach(() => {
    origFailClose = _postRunDeps.failAndClose;
    origDetect = _postRunDeps.detectMergeConflict;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
  });

  afterEach(() => {
    _postRunDeps.failAndClose = origFailClose;
    _postRunDeps.detectMergeConflict = origDetect;
  });

  test("escalates, reporting the exit code, failed phases and rate-limited state", async () => {
    const ctx = makeTestContext({ sessionManager: undefined, sessionId: undefined });
    const planResult = makePlanResult({
      success: false,
      phaseOutputs: {
        "some-gate": { passed: false, findings: [{ source: "test-runner" }] },
        "another-phase": { success: true },
      },
    });
    const inspection = makeInspection({
      agentResult: makeAgentResult({ success: false, exitCode: 7, rateLimited: true, output: "boom" }),
    });

    const result = await decideStageAction(ctx, planResult, inspection, makeInspectionOpts());

    if (result.action !== "escalate") throw new Error(`expected action "escalate", got "${result.action}"`);
    expect(result.reason).toContain("exit 7");
    expect(result.reason).toContain("rate-limited");
    expect(result.reason).toContain("some-gate");
    expect(result.reason).not.toContain("another-phase");
  });
});

describe("decideStageAction — non-TDD success auto-commits and continues", () => {
  let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
  let origDetect: typeof _postRunDeps.detectMergeConflict;

  beforeEach(() => {
    origAutoCommit = _postRunDeps.autoCommitIfDirty;
    origDetect = _postRunDeps.detectMergeConflict;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
  });

  afterEach(() => {
    _postRunDeps.autoCommitIfDirty = origAutoCommit;
    _postRunDeps.detectMergeConflict = origDetect;
  });

  test("calls autoCommitIfDirty with the story id and workdir, then returns continue", async () => {
    const calls: Array<[string, string, string, string]> = [];
    _postRunDeps.autoCommitIfDirty = mock(async (workdir: string, stage: string, mode: string, storyId: string) => {
      calls.push([workdir, stage, mode, storyId]);
    }) as typeof _postRunDeps.autoCommitIfDirty;

    const ctx = makeTestContext();
    const planResult = makePlanResult({ success: true });
    const inspection = makeInspection({ agentResult: makeAgentResult({ estimatedCostUsd: 0.5 }) });

    const result = await decideStageAction(ctx, planResult, inspection, makeInspectionOpts());

    expect(result).toEqual({ action: "continue" });
    expect(calls).toEqual([[ctx.workdir, "execution", "single-session", ctx.story.id]]);
  });
});
