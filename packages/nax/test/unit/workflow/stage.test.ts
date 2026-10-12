import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertNaxError,
  cleanupTempDir,
  makeMockCallContext,
  makeMockRuntime,
  makeNaxConfig,
  makeStepContext,
  makeTempDir,
  makeTestContext,
} from "@test/helpers";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { defaultWorkflowAdvisor } from "@/workflow/advisor";
import { workflowRunDir } from "@/workflow/paths";
import { newStoryRecord, readResult } from "@/workflow/result";
import { _workflowStageDeps, workflowStage } from "@/workflow/stage";
import type { StoryLoopEnv, StoryLoopOutcome } from "@/workflow/story-loop";

const original = { ..._workflowStageDeps };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_workflowStageDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

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
  opts: {
    resume?: StoryLoopEnv["resume"];
    briefs?: string[];
    briefPath?: string;
    closed?: string[];
    buildCallCtx?: () => Promise<never>;
    updates?: unknown[];
  } = {},
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
    sc: makeStepContext(opts.briefPath ? { briefPath: opts.briefPath } : {}),
    env: {
      ...makeEnv(),
      resume: opts.resume ?? null,
      sink: {
        update: async (patch) => {
          opts.updates?.push(patch);
        },
        ledger: async () => {},
      },
    },
    closeOnError: async (reason) => {
      opts.closed?.push(reason);
    },
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

    const dir = makeTempDir("wf-stage-brief-");
    dirs.push(dir);
    const briefPath = join(dir, "brief.md");
    await Bun.write(briefPath, "carried brief");
    const resumed: string[] = [];
    wire(async () => OUTCOME, { briefs: resumed, resume: newStoryRecord("US-001", 5, "t"), briefPath });
    await workflowStage.execute(makeTestContext());
    expect(resumed).toEqual([]);
  });

  test("a resumed story whose prior brief is missing gets a fresh brief", async () => {
    const dir = makeTempDir("wf-stage-brief-");
    dirs.push(dir);
    const rewritten: string[] = [];
    wire(async () => OUTCOME, {
      briefs: rewritten,
      resume: newStoryRecord("US-001", 5, "t"),
      briefPath: join(dir, "brief.md"),
    });
    await workflowStage.execute(makeTestContext());
    expect(rewritten).toEqual(["brief"]);
  });

  test("a batch of more than one story throws WORKFLOW_BATCH_UNREACHABLE and runs nothing", async () => {
    let looped = false;
    wire(async () => {
      looped = true;
      return OUTCOME;
    });
    const ctx = makeTestContext();
    const batched = { ...ctx, stories: [ctx.story, { ...ctx.story, id: "US-002" }] };
    const err = await workflowStage.execute(batched).catch((e: unknown) => e);
    assertNaxError(err);
    expect(err.code).toBe("WORKFLOW_BATCH_UNREACHABLE");
    expect(looped).toBe(false);
  });

  test("an abort swallowed inside the loop still rethrows after it returns", async () => {
    const ac = new AbortController();
    wire(async () => {
      ac.abort();
      return OUTCOME;
    });
    const ctx = makeTestContext({ abortSignal: ac.signal });
    const err = await workflowStage.execute(ctx).catch((e: unknown) => e);
    assertNaxError(err);
    expect(err.code).toBe("WORKFLOW_ABORTED");
    expect(ctx.agentResult).toBeUndefined();
  });

  test("a contained loop error closes the story record gate-open", async () => {
    const closed: string[] = [];
    wire(
      async () => {
        throw new Error("bug");
      },
      { closed },
    );
    await workflowStage.execute(makeTestContext());
    expect(closed).toEqual(["bug"]);
  });

  test("an abort does not close the record", async () => {
    const closed: string[] = [];
    wire(
      async () => {
        throw new Error("aborted");
      },
      { closed },
    );
    const ac = new AbortController();
    ac.abort();
    await expect(workflowStage.execute(makeTestContext({ abortSignal: ac.signal }))).rejects.toThrow("aborted");
    expect(closed).toEqual([]);
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

  test("per-role token totals are written onto the story record (spec §9)", async () => {
    const runtime = makeMockRuntime({ costAggregator: createNoOpCostAggregator() });
    const updates: unknown[] = [];
    wire(
      async () => {
        runtime.dispatchEvents.emitDispatch(
          makeEvent({
            sessionRole: "wf-implementer",
            estimatedCostUsd: 0.5,
            tokenUsage: { inputTokens: 20, outputTokens: 7 },
          }),
        );
        return OUTCOME;
      },
      { updates },
    );
    await workflowStage.execute(makeTestContext({ runtime }));
    expect(updates.at(-1)).toEqual({
      tokensByRole: { "wf-implementer": { inputTokens: 20, outputTokens: 7, costUsd: 0.5, calls: 1 } },
    });
  });
});

describe("workflowStage with the real story env", () => {
  test("a forced loop throw leaves a closed record in result.json", async () => {
    const outputDir = makeTempDir("wf-stage-out-");
    const workdir = makeTempDir("wf-stage-work-");
    dirs.push(outputDir, workdir);
    const config = makeNaxConfig({ outputDir });
    const runtime = makeMockRuntime({ config, workdir });
    const ctx = makeTestContext({
      config,
      rootConfig: config,
      runtime,
      projectDir: workdir,
      workdir,
      storyGitRef: "base123",
      prd: { ...makeTestContext().prd, feature: "feat" },
    });
    _workflowStageDeps.buildWorkflowCallContext = async () => ({
      callCtx: makeMockCallContext(),
      dispose: async () => {},
    });
    _workflowStageDeps.writeBrief = async () => {};
    _workflowStageDeps.runStoryLoop = async () => {
      throw new Error("forced");
    };
    expect(await workflowStage.execute(ctx)).toEqual({ action: "continue" });
    const result = await readResult(workflowRunDir(runtime.outputDir, "feat", runtime.runId));
    expect(result?.stories[ctx.story.id]).toMatchObject({
      state: "complete-gate-open",
      reason: "workflow error: forced",
      phase: "closed",
    });
  });
});
