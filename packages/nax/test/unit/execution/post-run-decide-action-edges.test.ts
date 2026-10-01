/**
 * decideStageAction — unpinned branch edges, characterised before the
 * cognitive-complexity drain (B1). The three existing suites pin most routing
 * (post-run-decide-action, post-run-inspection, post-run-inspection-exhaustion)
 * plus the oscillation breaker's AC4-AC12, but NOTHING pinned:
 *
 * 1. the recurrence-breaker RETURN wiring — `maybeHandleRecurrenceBreaker` has
 *    direct unit tests and the e2e harness stops short of decideStageAction
 *    (see test/e2e/review-recurrence-breaker.e2e.test.ts's header), so no test
 *    proved decideStageAction consults the breaker and returns its verdict;
 * 2. breaker ORDER — oscillation is consulted before recurrence;
 * 3. the oscillation pause notify PAYLOAD (AC11 pins only `type === "notify"`);
 * 4. the `&& opts.initialRef` half of the TDD rollback guard;
 * 5. TDD-mode success skipping autoCommitIfDirty;
 * 6. the `ctx.interaction` / `isTriggerEnabled` halves of the merge-conflict
 *    guard (only the enabled-and-proceeding arms were pinned);
 * 7. the `?? "unknown"` fallbacks in the human-review pause reason and the
 *    `category=` segment of the generic failure reason.
 *
 * Every dep stub here is a plain arrow function — no single-token cast
 * expressions (the escape-hatch ratchet counts loose casts per file, and new
 * files start at 0).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeInteractionChain, makeNaxConfig, makeTestContext } from "@test/helpers";
import type { AgentResult } from "@/agents/types";
import { _captureDeps } from "@/execution/lifecycle/test-baseline-capture";
import { _postRunDeps, decideStageAction, type PostRunInspectionResult } from "@/execution/post-run";
import type { ReviewRecurrenceStore } from "@/execution/recurrence-store";
import type { InteractionRequest } from "@/interaction/types";
import { makeInspectionOpts, makePlanResult, TEST_RUNNER_FINDING } from "./_post-run-fixtures";

const ORIGINAL_DEPS: typeof _postRunDeps = { ..._postRunDeps };
const ORIGINAL_WRITE_STORY_BASELINE = _captureDeps.writeStoryBaseline;

afterEach(() => {
  Object.assign(_postRunDeps, ORIGINAL_DEPS);
  _captureDeps.writeStoryBaseline = ORIGINAL_WRITE_STORY_BASELINE;
});

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
    providerUnavailable: false,
    combinedOutput: "",
    ...overrides,
  };
}

/** Enable both breakers at threshold 2 without any casts. */
function makeBreakerConfig(): ReturnType<typeof makeNaxConfig> {
  return makeNaxConfig({
    review: { conflictDetection: { enabled: true, maxOscillations: 2, maxCrossAttemptRecurrences: 2 } },
  });
}

function recordRecurrence(store: ReviewRecurrenceStore, storyId: string, count: number): void {
  store.set(`${storyId}::semantic-review`, { keySightings: new Map([["k1", count + 1]]), maxRecurrences: count });
}

describe("decideStageAction — recurrence-breaker pause is returned (unpinned wiring)", () => {
  test("a tripped cross-attempt recurrence breaker pauses with its reason", async () => {
    const ctx = makeTestContext();
    ctx.config = makeBreakerConfig();
    recordRecurrence(ctx.runtime.reviewFindingRecurrences, ctx.story.id, 2);

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = makeInspection();

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    if (result.action !== "pause") throw new Error(`expected pause, got ${result.action}`);
    expect(result.reason).toBe(
      'Cross-attempt review deadlock: reviewer "semantic-review" produced the same finding across 2 ' +
        "later attempt(s) (max 2) — this looks like two reviewers disagreeing " +
        "on the same code, not the implementer failing to fix a finding",
    );
  });
});

describe("decideStageAction — breaker order: oscillation before recurrence", () => {
  test("when both breakers trip, the oscillation reason wins", async () => {
    const ctx = makeTestContext();
    ctx.config = makeBreakerConfig();
    ctx.runtime.rectificationOscillations.set(ctx.story.id, 2);
    recordRecurrence(ctx.runtime.reviewFindingRecurrences, ctx.story.id, 2);

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = makeInspection();

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    if (result.action !== "pause") throw new Error(`expected pause, got ${result.action}`);
    expect(result.reason).toBe(
      "Rectification oscillation threshold reached: 2 resolved finding sources reappeared across attempts (max 2)",
    );
  });
});

describe("decideStageAction — oscillation pause notify payload", () => {
  test("the notify carries story, stage, fallback, and the derived feature name", async () => {
    const sent: InteractionRequest[] = [];
    const chain = makeInteractionChain({
      send: async (request: InteractionRequest) => {
        sent.push(request);
      },
    });
    const ctx = makeTestContext({ interaction: chain, featureDir: "/tmp/feat/my-feature" });
    ctx.config = makeBreakerConfig();
    ctx.runtime.rectificationOscillations.set(ctx.story.id, 2);

    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = makeInspection();

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result.action).toBe("pause");
    expect(sent).toHaveLength(1);
    const request = sent[0];
    if (!request) throw new Error("expected one notify request");
    expect(request.type).toBe("notify");
    expect(request.stage).toBe("execution");
    expect(request.storyId).toBe(ctx.story.id);
    expect(request.featureName).toBe("my-feature");
    expect(request.summary).toBe(`Oscillation paused: ${ctx.story.id}`);
    expect(request.detail).toBe(
      `Story: ${ctx.story.title}\nReason: Rectification oscillation threshold reached: ` +
        "2 resolved finding sources reappeared across attempts (max 2)",
    );
    expect(request.fallback).toBe("continue");
  });
});

describe("decideStageAction — TDD rollback guard halves", () => {
  test("rollback is skipped when shouldRollback fires but initialRef is null", async () => {
    const rollbackCalls: string[] = [];
    _postRunDeps.rollbackToRef = async (..._args) => {
      rollbackCalls.push("rollback");
    };

    const ctx = makeTestContext({ interaction: undefined });
    const planResult = makePlanResult({ success: false });
    const inspection = makeInspection({ failureCategory: "isolation-violation" });
    const opts = makeInspectionOpts({
      tddMode: { isLite: false, rollbackEnabled: true },
      initialRef: null,
    });

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(rollbackCalls).toHaveLength(0);
    expect(result.action).toBe("escalate");
  });
});

describe("decideStageAction — TDD success path", () => {
  test("skips autoCommitIfDirty but still continues", async () => {
    const autoCommitCalls: string[] = [];
    const baselineWrites: string[] = [];
    _postRunDeps.autoCommitIfDirty = async () => {
      autoCommitCalls.push("commit");
    };
    _postRunDeps.detectMergeConflict = () => false;
    _captureDeps.writeStoryBaseline = async () => {
      baselineWrites.push("baseline");
    };

    const ctx = makeTestContext();
    const planResult = makePlanResult({ success: true });
    const inspection = makeInspection();
    const opts = makeInspectionOpts({ tddMode: { isLite: false, rollbackEnabled: false } });

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result).toEqual({ action: "continue" });
    expect(autoCommitCalls).toHaveLength(0);
  });
});

describe("decideStageAction — merge-conflict guard halves", () => {
  function stubGuards(): { checkCalls: string[] } {
    const checkCalls: string[] = [];
    _postRunDeps.detectMergeConflict = () => true;
    _postRunDeps.checkMergeConflict = async () => {
      checkCalls.push("check");
      return true;
    };
    _postRunDeps.autoCommitIfDirty = async () => undefined;
    _captureDeps.writeStoryBaseline = async () => undefined;
    return { checkCalls };
  }

  const planResult = () => makePlanResult({ success: true });
  const inspection = () => makeInspection({ combinedOutput: "CONFLICT (content): Merge conflict in file.ts" });

  test("no interaction chain → conflict is never checked, success path continues", async () => {
    const { checkCalls } = stubGuards();
    const ctx = makeTestContext({ interaction: undefined });
    const opts = makeInspectionOpts();

    const result = await decideStageAction(ctx, planResult(), inspection(), opts);

    expect(result).toEqual({ action: "continue" });
    expect(checkCalls).toHaveLength(0);
  });

  test("merge-conflict trigger disabled → conflict is never checked, success path continues", async () => {
    const { checkCalls } = stubGuards();
    const ctx = makeTestContext({
      interaction: makeInteractionChain(),
      config: makeNaxConfig({ interaction: { triggers: { "merge-conflict": false } } }),
    });
    const opts = makeInspectionOpts();

    const result = await decideStageAction(ctx, planResult(), inspection(), opts);

    expect(result).toEqual({ action: "continue" });
    expect(checkCalls).toHaveLength(0);
  });
});

describe("decideStageAction — unknown-category fallbacks", () => {
  test("human-review pause without a category resolves the reason to unknown", async () => {
    const ctx = makeTestContext({ interaction: undefined });
    const planResult = makePlanResult({ success: false });
    const inspection = makeInspection({ needsHumanReview: true, failureCategory: undefined });
    const opts = makeInspectionOpts({ tddMode: { isLite: false, rollbackEnabled: false } });

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result).toEqual({ action: "pause", reason: "Human review needed: unknown" });
  });

  test("generic failure reason carries a category segment when the inspection supplies one", async () => {
    _postRunDeps.detectMergeConflict = () => false;
    _postRunDeps.failAndClose = async () => undefined;

    const ctx = makeTestContext({ sessionManager: undefined, sessionId: undefined });
    const planResult = makePlanResult({ success: false });
    const inspection = makeInspection({
      failureCategory: "session-failure",
      agentResult: makeAgentResult({ success: false, exitCode: 3 }),
    });
    const opts = makeInspectionOpts();

    const result = await decideStageAction(ctx, planResult, inspection, opts);

    if (result.action !== "escalate") throw new Error(`expected escalate, got ${result.action}`);
    expect(result.reason).toContain("exit 3");
    expect(result.reason).toContain("category=session-failure");
  });
});
