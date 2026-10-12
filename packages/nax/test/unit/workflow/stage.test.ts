import { afterEach, describe, expect, test } from "bun:test";
import { makeMockCallContext, makeTestContext } from "@test/helpers";
import { defaultWorkflowAdvisor } from "@/workflow/advisor";
import { _workflowStageDeps, workflowStage } from "@/workflow/stage";
import type { StoryLoopEnv, StoryLoopOutcome } from "@/workflow/story-loop";
import { makeStepContext } from "./step-context-helper";

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

function wire(loop: () => Promise<StoryLoopOutcome>): () => boolean {
  let disposed = false;
  _workflowStageDeps.buildWorkflowCallContext = async () => ({
    callCtx: makeMockCallContext(),
    dispose: async () => {
      disposed = true;
    },
  });
  _workflowStageDeps.buildStoryEnv = async () => ({ sc: makeStepContext(), env: makeEnv() });
  _workflowStageDeps.writeBrief = async () => {};
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
});
