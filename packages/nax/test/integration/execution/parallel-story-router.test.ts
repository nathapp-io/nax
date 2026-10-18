import { afterEach, expect, mock, test } from "bun:test";
import { makeTestContext } from "@test/helpers";
import { buildWorktreePipelineContext } from "@/execution/parallel-worker";
import { type ParallelDispatchDeps, runParallelDispatch } from "@/execution/unified-executor-parallel-dispatch";
import { routingStage } from "@/pipeline/stages/routing";
import { PluginRegistry } from "@/plugins/registry";
import type { PRD } from "@/prd/types";
import type { RoutingStrategy } from "@/routing";
import { buildNaxIgnoreIndex } from "@/utils/path-filters";
import { makeCtx, makePendingStory, makePrd, setupParallelMetricsFixtures } from "./_parallel-metrics-helpers";

setupParallelMetricsFixtures();
afterEach(() => mock.restore());

test.each(["shadow", "apply"] as const)(
  "parallel workers persist %s story-router decisions at the batch boundary",
  async (mode) => {
    const stories = [makePendingStory("US-R1"), makePendingStory("US-R2")];
    for (const story of stories) {
      story.routing = {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "plan",
        agent: "native",
        agentProfileId: "planned",
        profileModelTier: "balanced",
      };
    }
    const prd = makePrd(stories);
    const ctx = makeCtx({ parallelCount: 2 });
    ctx.config = structuredClone(ctx.config);
    ctx.config.routing.router = { mode, precedence: "router", timeoutMs: 5000 };
    ctx.config.routing.agents = {
      enabled: true,
      strategy: "off",
      default: "planned",
      profiles: [
        { id: "planned", strengths: [], target: { agent: "native", model: "balanced" } },
        { id: "picked", strengths: [], target: { agent: "native", model: "fast" } },
      ],
    };
    const route = mock<RoutingStrategy["route"]>(() => ({
      complexity: "simple" as const,
      modelTier: "fast" as const,
      testStrategy: "test-after" as const,
      reasoning: "router pick",
      agentProfileId: "picked",
    }));
    ctx.pluginRegistry = new PluginRegistry([
      {
        name: "parallel-router",
        version: "1.0.0",
        provides: ["router"],
        extensions: { router: { name: "parallel-router", route } },
      },
    ]);
    const savePrdProgress = mock<ParallelDispatchDeps["savePrdProgress"]>(async (saved: PRD) => {
      // Inspect a snapshot at the single-writer boundary, not the worker's mutable story.
      const snapshot = structuredClone(saved);
      for (const story of snapshot.userStories) {
        expect(story.status).toBe("passed");
        expect(story.routing?.agentProfileId).toBe(mode === "apply" ? "picked" : "planned");
        expect(story.routing?.routerDecision).toMatchObject({
          mode,
          router: "parallel-router",
          outcome: "picked",
          profileId: "picked",
          plannedProfileId: "planned",
          applied: mode === "apply",
        });
      }
    });
    const deps: ParallelDispatchDeps = {
      savePrdProgress,
      selectIndependentBatch: () => stories,
      preIterationTierCheck: async () => ({ shouldSkipIteration: false, prd, prdDirty: false }),
      runIteration: mock(async () => {
        throw new Error("unexpected sequential dispatch");
      }),
      runParallelBatch: async ({ stories: dispatched, ctx: batchCtx }) => {
        // Exercise the real worker context builder and routing stage; replace only
        // worktree/agent/merge I/O so this test isolates dispatch-to-persistence wiring.
        await Promise.all(
          dispatched.map(async (story) => {
            const worker = makeTestContext({
              ...buildWorktreePipelineContext(batchCtx.pipelineContext, story),
              story,
              stories: [story],
              workdir: ctx.workdir,
            });
            expect(worker.skipPrdPersistence).toBe(true);
            expect(await routingStage.execute(worker)).toEqual({ action: "continue" });
          }),
        );
        return { completed: dispatched, failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 };
      },
    };
    await runParallelDispatch(
      {
        ctx,
        state: { prd, prdDirty: false, totalCost: 0, storiesCompleted: 0, lastStoryId: null, warningSent: false },
        iterations: 1,
        allStoryMetrics: [],
        naxIgnoreIndex: await buildNaxIgnoreIndex(ctx.workdir),
        costLimit: Infinity,
        reportCost: () => {},
      },
      deps,
    );
    expect(route).toHaveBeenCalledTimes(2);
    expect(route.mock.calls.map(([story]) => story.id).sort()).toEqual(["US-R1", "US-R2"]);
    expect(savePrdProgress).toHaveBeenCalledTimes(1);
  },
);
