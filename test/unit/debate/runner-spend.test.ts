/**
 * #1960 — DebateResult.totalCostUsd must mean total spend.
 *
 * `src/debate/runner.ts` reads scope snapshots (unlike its siblings, which use
 * local accumulators), so the two totals it reports had to start reading
 * through `totalSpendUsd` — otherwise a priced failed dispatch recorded against
 * a debate scope was silently dropped from the reported cost.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeCallOp, makeLogger, makeMockAgentManager, makeMockRuntime, makeSessionManager } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { DebateRunner } from "@/debate/runner";
import { _debateSessionDeps } from "@/debate/session-helpers";
import type { DebateStageConfig } from "@/debate/types";
import * as callModule from "@/operations";
import type { CallContext } from "@/operations/types";
import type { ICostAggregator } from "@/runtime";
import { CostAggregator, createNoOpCostAggregator } from "@/runtime/cost-aggregator";

function makeStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
    ],
    ...overrides,
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => makeLogger());
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

describe("DebateRunner — scope totals fold failed-dispatch spend (#1960)", () => {
  function makeCtxWithCostAgg(agg: CostAggregator): CallContext {
    const agentManager = makeMockAgentManager({
      completeFn: async (_name: string, _p: string, _o: unknown) => ({
        output: '{"passed":true}',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });
    // Mirror runner.test.ts's seam: the no-op aggregator is injected so the
    // runtime's close()/drain() stays inert, but openScope delegates to the
    // real backing aggregator so scope snapshots fold recorded rows.
    const costAggregator: ICostAggregator = {
      ...createNoOpCostAggregator(),
      openScope: (scopeId?: string) => agg.openScope(scopeId),
    };
    const runtime = makeMockRuntime({
      agentManager,
      sessionManager: makeSessionManager(),
      costAggregator,
    });
    return {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp/work",
      agentName: "claude",
      storyId: "US-cost",
      featureName: "feat-cost",
    };
  }

  function spyCallOpSeedingDebaterScope(agg: CostAggregator, withErrorRow: boolean): void {
    let seeded = false;
    spyOn(callModule, "callOp").mockImplementation(
      makeCallOp({
        fallback: '{"passed":true}',
        onDispatch: (op, callCtx) => {
          if (op.name !== "debate-propose" || callCtx.scopeId === undefined || seeded) return;
          seeded = true;
          const scopeId = callCtx.scopeId;
          agg.record({
            ts: 1,
            runId: "r-001",
            agentName: "claude",
            model: "claude-sonnet-4-6",
            stage: "review",
            storyId: "US-cost",
            scopeId,
            estimatedCostUsd: 0.02,
            exactCostUsd: 0.02,
            costUsd: 0.02,
            confidence: "estimated",
            durationMs: 500,
          });
          if (withErrorRow) {
            agg.recordError({
              kind: "error",
              ts: 2,
              runId: "r-001",
              agentName: "claude",
              stage: "review",
              storyId: "US-cost",
              scopeId,
              errorCode: "DISPATCH_ERROR",
              estimatedCostUsd: 0.005,
              exactCostUsd: 0.005,
              costUsd: 0.005,
              durationMs: 50,
            });
          }
        },
      }),
    );
  }

  function makePanelRunner(ctx: CallContext): DebateRunner {
    return new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
    });
  }

  test("totalCostUsd folds a priced error row recorded against the debater scope (0.02 + 0.005 = 0.025)", async () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const ctx = makeCtxWithCostAgg(agg);
    spyCallOpSeedingDebaterScope(agg, true);
    const result = await makePanelRunner(ctx).run("prompt");
    expect(result.outcome).toBe("passed");
    expect(result.totalCostUsd).toBeCloseTo(0.025);
  });

  test("totalCostUsd is unchanged at the successful spend when no error row exists", async () => {
    const agg = new CostAggregator("r-001", "/tmp/drain");
    const ctx = makeCtxWithCostAgg(agg);
    spyCallOpSeedingDebaterScope(agg, false);
    const result = await makePanelRunner(ctx).run("prompt");
    expect(result.outcome).toBe("passed");
    expect(result.totalCostUsd).toBeCloseTo(0.02);
    expect(agg.snapshot().totalErrorCostUsd).toBe(0);
  });
});
