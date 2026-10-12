import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext, makeMockRuntime, makeStepContext, makeTestContext } from "@test/helpers";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { defaultWorkflowAdvisor } from "@/workflow/advisor";
import { newStoryRecord } from "@/workflow/result";
import { _workflowStageDeps, workflowStage } from "@/workflow/stage";
import type { StoryLoopEnv, StoryLoopOutcome } from "@/workflow/story-loop";

const original = { ..._workflowStageDeps };
afterEach(() => Object.assign(_workflowStageDeps, original));

function makeEnv(): StoryLoopEnv {
  return {
    storyId: "US-001",
    maxFixRounds: 5,
    steps: {
      implement: async () => {
        throw new Error("unused");
      },
      gates: async () => {
        throw new Error("unused");
      },
      fullSuite: async () => {
        throw new Error("unused");
      },
      storyReview: async () => {
        throw new Error("unused");
      },
      reReview: async () => {
        throw new Error("unused");
      },
      head: async () => "h",
      uncommitted: async () => [],
      costExceeded: () => false,
    },
    advisor: defaultWorkflowAdvisor,
    sink: { update: async () => {}, ledger: async () => {} },
    resume: null,
  };
}

const OUTCOME: StoryLoopOutcome = { state: "complete", reason: "ok", rounds: 0, rulings: [], unreviewed: false };

function makeEvent(overrides: Partial<SessionTurnDispatchEvent>): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "s",
    sessionRole: "main",
    prompt: "p",
    response: "r",
    agentName: "claude",
    stage: "run",
    resolvedPermissions: { mode: "approve-reads", bashApproval: "raw" },
    roundTrips: 0,
    roundTripUnit: "agent-run",
    protocolIds: {},
    origin: "runAsSession",
    durationMs: 1,
    timestamp: 1,
    ...overrides,
  };
}

function wire(
  loop: () => Promise<StoryLoopOutcome>,
  opts: { resume?: StoryLoopEnv["resume"]; briefs?: string[]; buildCallCtx?: () => Promise<never> } = {},
): () => boolean {
  let disposed = false;
  _workflowStageDeps.buildWorkflowCallContext =
    opts.buildCallCtx ??
    (async () => ({
      callCtx: makeMockCallContext(),
      dispose: async () => {
        disposed = true;
      },
    }));
  _workflowStageDeps.buildStoryEnv = async () => ({
    sc: makeStepContext(),
    env: { ...makeEnv(), resume: opts.resume ?? null },
  });
  _workflowStageDeps.writeBrief = async () => {
    opts.briefs?.push("brief");
  };
  _workflowStageDeps.runStoryLoop = loop;
  return () => disposed;
}

describe("workflowStage", () => {
  test("returns continue, sets agentResult, does not touch storyGitRef or mark the PRD", async () => {
    const disposed = wire(async () => ({
      state: "complete-gate-open",
      reason: "red: lint",
      rounds: 5,
      rulings: [],
      unreviewed: false,
    }));
    const ctx = makeTestContext({ storyGitRef: "base123" });
    const result = await workflowStage.execute(ctx);
    expect(result).toEqual({ action: "continue" });
    expect(ctx.agentResult?.success).toBe(true);
    expect(ctx.storyGitRef).toBe("base123");
    expect(ctx.prd.userStories.find((s) => s.id === ctx.story.id)?.status).not.toBe("passed");
    expect(disposed()).toBe(true);
  });

  test("an unexpected loop error still returns continue (W-R3)", async () => {
    wire(async () => {
      throw new Error("bug");
    });
    expect(await workflowStage.execute(makeTestContext())).toEqual({ action: "continue" });
  });

  test("abort propagates", async () => {
    wire(async () => {
      throw new Error("aborted");
    });
    const ac = new AbortController();
    ac.abort();
    await expect(workflowStage.execute(makeTestContext({ abortSignal: ac.signal }))).rejects.toThrow("aborted");
  });

  test("buildWorkflowCallContext throwing still continues and unsubscribes the dispatch listener", async () => {
    wire(async () => OUTCOME, {
      buildCallCtx: async () => {
        throw new Error("wiring failed");
      },
    });
    const runtime = makeMockRuntime({ costAggregator: createNoOpCostAggregator() });
    let subscribed = 0;
    let unsubscribed = 0;
    const realOn = runtime.dispatchEvents.onDispatch.bind(runtime.dispatchEvents);
    runtime.dispatchEvents.onDispatch = (listener) => {
      subscribed++;
      const off = realOn(listener);
      return () => {
        unsubscribed++;
        off();
      };
    };
    const ctx = makeTestContext({ runtime });
    expect(await workflowStage.execute(ctx)).toEqual({ action: "continue" });
    expect(subscribed).toBe(1);
    expect(unsubscribed).toBe(1);
    expect(ctx.agentResult?.success).toBe(true);
  });

  test("buildWorkflowCallContext throwing under abort rethrows", async () => {
    wire(async () => OUTCOME, {
      buildCallCtx: async () => {
        throw new Error("aborted");
      },
    });
    const ac = new AbortController();
    ac.abort();
    await expect(workflowStage.execute(makeTestContext({ abortSignal: ac.signal }))).rejects.toThrow("aborted");
  });

  test("the brief is written on a fresh story and skipped on resume", async () => {
    const fresh: string[] = [];
    wire(async () => OUTCOME, { briefs: fresh });
    await workflowStage.execute(makeTestContext());
    expect(fresh).toEqual(["brief"]);

    const resumed: string[] = [];
    wire(async () => OUTCOME, { briefs: resumed, resume: newStoryRecord("US-001", 5, "t") });
    await workflowStage.execute(makeTestContext());
    expect(resumed).toEqual([]);
  });

  test("dispose runs on the error path", async () => {
    const disposed = wire(async () => {
      throw new Error("bug");
    });
    await workflowStage.execute(makeTestContext());
    expect(disposed()).toBe(true);
  });

  test("cost and token totals from dispatch events land in agentResult", async () => {
    const runtime = makeMockRuntime({ costAggregator: createNoOpCostAggregator() });
    wire(async () => {
      runtime.dispatchEvents.emitDispatch(
        makeEvent({ exactCostUsd: 0.25, estimatedCostUsd: 9, tokenUsage: { inputTokens: 10, outputTokens: 5 } }),
      );
      runtime.dispatchEvents.emitDispatch(
        makeEvent({ estimatedCostUsd: 0.5, tokenUsage: { inputTokens: 20, outputTokens: 7 } }),
      );
      return OUTCOME;
    });
    const ctx = makeTestContext({ runtime });
    await workflowStage.execute(ctx);
    expect(ctx.agentResult?.estimatedCostUsd).toBeCloseTo(0.75);
    expect(ctx.agentResult?.tokenUsage).toEqual({ inputTokens: 30, outputTokens: 12 });
  });
});
