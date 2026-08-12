import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { calculateMaxIterations } from "../../../src/execution/escalation/escalation";
import {
  _tierEscalationDeps,
  handleTierEscalation,
  preIterationTierCheck,
  shouldRetrySameTier,
} from "../../../src/execution/escalation/tier-escalation";
import { handlePipelineFailure } from "../../../src/execution/pipeline-result-handler";
import { collectObservations } from "../../../src/plugins/builtin/curator";

type Loose = Record<string, unknown>;
type TierDeps = typeof _tierEscalationDeps;

const originalTierDeps: TierDeps = { ..._tierEscalationDeps };
const noOpLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

afterEach(() => {
  Object.assign(_tierEscalationDeps, originalTierDeps);
  mock.restore();
});

function story(overrides: Loose = {}): Loose {
  return {
    id: "US-escalation",
    title: "Escalation story",
    description: "",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    attempts: 0,
    escalations: [],
    routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "" },
    ...overrides,
  };
}

function prd(oneStory: Loose): Loose {
  return {
    project: "acceptance",
    feature: "escalation-correctness",
    branchName: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [oneStory],
  };
}

function escalationConfig(enabled = true): Loose {
  return {
    autoMode: {
      escalation: {
        enabled,
        escalateEntireBatch: false,
        tierOrder: [
          { tier: "fast", attempts: 2 },
          { tier: "balanced", attempts: 2 },
          { tier: "powerful", attempts: 2 },
        ],
      },
    },
    routing: { llm: { mode: "per-story" }, strategy: "keyword" },
    models: {},
  };
}

function escalationContext(overrides: Loose = {}): Loose {
  const selectedStory = story();
  return {
    story: selectedStory,
    storiesToExecute: [selectedStory],
    isBatchExecution: false,
    routing: { modelTier: "fast", testStrategy: "test-after" },
    pipelineResult: { reason: "tests failed", context: {} },
    config: escalationConfig(),
    prd: prd(selectedStory),
    prdPath: "/tmp/escalation-correctness-prd.json",
    featureDir: undefined,
    hooks: { hooks: [] },
    feature: "escalation-correctness",
    totalCost: 0,
    workdir: "/tmp",
    ...overrides,
  };
}

async function runTierCheck(selectedStory: Loose, config = escalationConfig()) {
  return preIterationTierCheck(
    selectedStory as never,
    { modelTier: "fast" },
    config as never,
    prd(selectedStory) as never,
    "/tmp/escalation-correctness-prd.json",
    undefined,
    { hooks: [] } as never,
    "escalation-correctness",
    0,
    "/tmp",
  );
}

function curatorContext(root: string, logFilePath: string): Loose {
  return {
      runId: "run-escalation",
      feature: "escalation-correctness",
      workdir: root,
      prdPath: join(root, "prd.json"),
      branch: "main",
      totalDurationMs: 0,
      totalCost: 0,
      storySummary: { completed: 0, failed: 0, skipped: 0, paused: 0 },
      stories: [],
      version: "1",
      pluginConfig: {},
      logger: noOpLogger,
      config: {},
      outputDir: join(root, "out"),
      globalDir: join(root, "global"),
      projectKey: "acceptance",
      curatorRollupPath: join(root, "rollup.jsonl"),
      logFilePath,
  };
}

async function observationsFor(entries: Loose[]): Promise<unknown[]> {
  const root = await mkdtemp(join(tmpdir(), "nax-escalation-log-"));
  const logFilePath = join(root, "run.jsonl");
  await writeFile(logFilePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  try {
    return await collectObservations(curatorContext(root, logFilePath) as never);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function escalationLog(data: Loose): Loose {
  return { timestamp: new Date().toISOString(), stage: "escalation", message: "Escalating story to next tier", data };
}

describe("escalation-correctness acceptance", () => {
  test("AC-1: handleTierEscalation obtains its logger through _tierEscalationDeps", async () => {
    const getSafeLogger = mock(() => noOpLogger);
    _tierEscalationDeps.getSafeLogger = getSafeLogger;
    _tierEscalationDeps.savePRD = mock(async () => {});
    await handleTierEscalation(escalationContext() as never);
    expect(getSafeLogger).toHaveBeenCalledTimes(1);
  });

  test("AC-2: escalation log records stage escalation and fromTier fast", async () => {
    const entries: Loose[] = [];
    _tierEscalationDeps.getSafeLogger = mock(() => ({ ...noOpLogger, warn: (stage: string, message: string, data: Loose) => entries.push({ stage, message, data }) }));
    _tierEscalationDeps.savePRD = mock(async () => {});
    await handleTierEscalation(escalationContext() as never);
    expect(entries).toContainEqual(expect.objectContaining({ stage: "escalation", data: expect.objectContaining({ fromTier: "fast" }) }));
  });

  test("AC-3: escalation log records nextTier balanced", async () => {
    const entries: Loose[] = [];
    _tierEscalationDeps.getSafeLogger = mock(() => ({ ...noOpLogger, warn: (stage: string, message: string, data: Loose) => entries.push({ stage, message, data }) }));
    _tierEscalationDeps.savePRD = mock(async () => {});
    await handleTierEscalation(escalationContext() as never);
    expect(entries).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ nextTier: "balanced" }) }));
  });

  test("AC-4: collector maps fromTier fast to an escalation observation", async () => {
    const result = await observationsFor([escalationLog({ fromTier: "fast", nextTier: "balanced" })]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "escalation", payload: { from: "fast" } });
  });

  test("AC-5: collector falls back to currentTier for escalation source", async () => {
    const result = await observationsFor([escalationLog({ currentTier: "fast", nextTier: "balanced" })]);
    expect(result[0]).toMatchObject({ payload: { from: "fast" } });
  });

  test("AC-6: handler log output is consumable as one escalation observation", async () => {
    const entries: Loose[] = [];
    _tierEscalationDeps.getSafeLogger = mock(() => ({ ...noOpLogger, warn: (stage: string, message: string, data: Loose) => entries.push({ stage, message, data }) }));
    _tierEscalationDeps.savePRD = mock(async () => {});
    await handleTierEscalation(escalationContext() as never);
    const result = await observationsFor(entries);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "escalation" });
  });

  test("AC-7: pre-iteration budget escalation log output is consumable", async () => {
    const entries: Loose[] = [];
    _tierEscalationDeps.getSafeLogger = mock(() => ({ ...noOpLogger, warn: (stage: string, message: string, data: Loose) => entries.push({ stage, message, data }) }));
    _tierEscalationDeps.savePRD = mock(async () => {});
    await runTierCheck(story({ attempts: 2 }));
    const result = await observationsFor(entries);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "escalation" });
  });

  test("AC-8: every collected escalation has a non-empty source tier", async () => {
    const result = await observationsFor([
      escalationLog({ fromTier: "fast", nextTier: "balanced" }),
      escalationLog({ currentTier: "balanced", nextTier: "powerful" }),
      escalationLog({ from: "powerful", to: "ultimate" }),
    ]);
    for (const observation of result as Array<{ kind: string; payload: { from: unknown } }>) {
      if (observation.kind === "escalation") expect(typeof observation.payload.from === "string" && observation.payload.from.length > 0).toBe(true);
    }
  });

  test("AC-9: RUNTIME_CRASH retries the same tier", () => expect(shouldRetrySameTier({ status: "RUNTIME_CRASH", success: false })).toBe(true));
  test("AC-10: undefined runtime result does not retry", () => expect(shouldRetrySameTier(undefined)).toBe(false));
  test("AC-11: TEST_FAILURE does not retry the same tier", () => expect(shouldRetrySameTier({ status: "TEST_FAILURE", success: false })).toBe(false));

  test("AC-12: runtime crash handling returns retry-same", async () => {
    const result = await handleTierEscalation(escalationContext({ runtimeCrashResult: { status: "RUNTIME_CRASH", success: false } }) as never);
    expect(result.outcome).toBe("retry-same");
  });

  test("AC-13: retry-same preserves the original PRD without marking it dirty", async () => {
    const context = escalationContext({ runtimeCrashResult: { status: "RUNTIME_CRASH", success: false } });
    const originalPrd = context.prd;
    const result = await handleTierEscalation(context as never);
    expect(result.outcome === "retry-same" ? result.prdDirty === false && result.prd === originalPrd : true).toBe(true);
  });

  test("AC-14: compile errors escalate one tier", async () => {
    _tierEscalationDeps.savePRD = mock(async () => {});
    const context = escalationContext({ pipelineResult: { reason: "compile", context: { tddFailureCategory: "compile-error" } } });
    const initialTier = (context.story as Loose).routing as Loose;
    const result = await handleTierEscalation(context as never);
    expect(result.outcome).toBe("escalated");
    expect(result.prd.userStories[0].routing.modelTier).toBe(initialTier.modelTier === "fast" ? "balanced" : "fast");
  });

  test("AC-15: pipeline runtime-crash escalation passes a RUNTIME_CRASH result to the handler", async () => {
    const module = await import("../../../src/execution/pipeline-result-handler");
    const deps = (module as unknown as { _resultHandlerDeps: Loose })._resultHandlerDeps;
    const spy = mock(async (context: Loose) => ({ outcome: "retry-same", prdDirty: false, prd: context.prd }));
    expect(typeof deps.handleTierEscalation).toBe("function");
    const original = deps.handleTierEscalation;
    deps.handleTierEscalation = spy;
    try {
      await handlePipelineFailure(pipelineContext() as never, pipelineResult("runtime-crash") as never);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ runtimeCrashResult: expect.objectContaining({ status: "RUNTIME_CRASH" }) }));
    } finally { deps.handleTierEscalation = original; }
  });

  test("AC-16: pipeline runtime crashes retain the current tier", async () => {
    const selectedStory = story();
    const result = await handlePipelineFailure(pipelineContext(selectedStory) as never, pipelineResult("runtime-crash") as never);
    expect(result.prd.userStories[0].routing.modelTier).toBe("fast");
  });

  test("AC-17: pipeline runtime crashes still record an attempt", async () => {
    const selectedStory = story({ attempts: 0 });
    const result = await handlePipelineFailure(pipelineContext(selectedStory) as never, pipelineResult("runtime-crash") as never);
    expect(result.prd.userStories[0].attempts).not.toBe(0);
  });

  test("AC-18: pipeline compile errors escalate one tier", async () => {
    _tierEscalationDeps.savePRD = mock(async () => {});
    const result = await handlePipelineFailure(pipelineContext(story()) as never, pipelineResult("compile-error") as never);
    expect(result.prd.userStories[0].routing.modelTier).toBe("balanced");
  });

  test("AC-19: default tier order is fast, balanced, powerful with two attempts each", () => {
    const tiers = (NaxConfigSchema.parse({}).autoMode.escalation.tierOrder as unknown as Array<{ name: string; attempts: number }>);
    expect(tiers).toHaveLength(3);
    expect(tiers).toEqual([{ name: "fast", attempts: 2 }, { name: "balanced", attempts: 2 }, { name: "powerful", attempts: 2 }]);
  });

  test("AC-20: calculateMaxIterations sums all three rung budgets", () => {
    expect(calculateMaxIterations([{ tier: "fast", attempts: 2 }, { tier: "balanced", attempts: 2 }, { tier: "powerful", attempts: 2 }])).toBe(6);
  });

  test("AC-21: a story below its rung budget runs", async () => expect((await runTierCheck(story({ attempts: 1 }))).shouldSkipIteration).toBe(false));
  test("AC-22: a story at its rung budget skips the iteration", async () => {
    _tierEscalationDeps.savePRD = mock(async () => {});
    expect((await runTierCheck(story({ attempts: 2 }))).shouldSkipIteration).toBe(true);
  });
  test("AC-23: budget escalation advances the PRD story to balanced", async () => {
    _tierEscalationDeps.savePRD = mock(async () => {});
    const result = await runTierCheck(story({ attempts: 2 }));
    expect(result.prd.userStories[0].routing.modelTier).toBe("balanced");
  });
  test("AC-24: budget escalation resets attempts to zero", async () => {
    _tierEscalationDeps.savePRD = mock(async () => {});
    const result = await runTierCheck(story({ attempts: 2 }));
    expect(result.prd.userStories[0].attempts).toBe(0);
  });
  test("AC-25: an absent current tier leaves iteration unskipped", async () => {
    expect((await runTierCheck(story({ attempts: 999, routing: { modelTier: "unknown" } }))).shouldSkipIteration).toBe(false);
  });
  test("AC-26: disabled escalation never skips an iteration", async () => {
    expect((await runTierCheck(story({ attempts: 2 }), escalationConfig(false))).shouldSkipIteration).toBe(false);
  });

  test("AC-27: sequential execution checks tier budget before runIteration", async () => {
    const { executeUnified, _unifiedExecutorDeps } = await import("../../../src/execution/unified-executor") as unknown as { executeUnified: Function; _unifiedExecutorDeps: Loose };
    const order: string[] = [];
    const originalCheck = _unifiedExecutorDeps.preIterationTierCheck;
    const originalRun = _unifiedExecutorDeps.runIteration;
    _unifiedExecutorDeps.preIterationTierCheck = mock(async () => { order.push("check"); return { shouldSkipIteration: false }; });
    _unifiedExecutorDeps.runIteration = mock(async (ctx: Loose, currentPrd: Loose) => { order.push("run"); return { prd: currentPrd, storiesCompletedDelta: 0, costDelta: 0, prdDirty: false, finalAction: "fail" }; });
    try {
      await executeUnified(executorContext() as never, prd(story()) as never);
      expect(_unifiedExecutorDeps.preIterationTierCheck).toHaveBeenCalledTimes(1);
      expect(order.indexOf("check")).toBeLessThan(order.indexOf("run"));
    }
    finally { _unifiedExecutorDeps.preIterationTierCheck = originalCheck; _unifiedExecutorDeps.runIteration = originalRun; }
  });

  test("AC-28: a skipped pre-iteration budget check does not call runIteration", async () => {
    const { executeUnified, _unifiedExecutorDeps } = await import("../../../src/execution/unified-executor") as unknown as { executeUnified: Function; _unifiedExecutorDeps: Loose };
    const originalCheck = _unifiedExecutorDeps.preIterationTierCheck;
    const originalRun = _unifiedExecutorDeps.runIteration;
    const run = mock(async () => ({ prd: prd(story()), storiesCompletedDelta: 0, costDelta: 0, prdDirty: false }));
    _unifiedExecutorDeps.preIterationTierCheck = mock(async () => ({ shouldSkipIteration: true, prdDirty: false }));
    _unifiedExecutorDeps.runIteration = run;
    try { await executeUnified(executorContext() as never, prd(story()) as never); expect(run).not.toHaveBeenCalled(); }
    finally { _unifiedExecutorDeps.preIterationTierCheck = originalCheck; _unifiedExecutorDeps.runIteration = originalRun; }
  });

  test("AC-29: batch execution checks every story before running the batch", async () => {
    const module = await import("../../../src/execution/unified-executor") as unknown as { executeUnified: Function; _unifiedExecutorDeps: Loose };
    const first = story({ id: "US-1" }); const second = story({ id: "US-2" });
    const check = mock(async () => ({ shouldSkipIteration: false }));
    expect(typeof module._unifiedExecutorDeps.preIterationTierCheck).toBe("function");
    const original = module._unifiedExecutorDeps.preIterationTierCheck;
    const originalSelect = module._unifiedExecutorDeps.selectIndependentBatch;
    const originalBatch = module._unifiedExecutorDeps.runParallelBatch;
    module._unifiedExecutorDeps.preIterationTierCheck = check;
    module._unifiedExecutorDeps.selectIndependentBatch = mock(() => [first, second]);
    module._unifiedExecutorDeps.runParallelBatch = mock(async () => ({ completed: [first, second], failed: [], mergeConflicts: [], storyCosts: new Map(), totalCost: 0 }));
    const batchPrd = { ...prd(first), userStories: [first, second] };
    try { await module.executeUnified(executorContext({ parallelCount: 2 }) as never, batchPrd as never); expect(check).toHaveBeenCalledTimes(2); expect(check.mock.calls.map((call) => (call[0] as Loose).id)).toEqual(["US-1", "US-2"]); }
    finally { module._unifiedExecutorDeps.preIterationTierCheck = original; module._unifiedExecutorDeps.selectIndependentBatch = originalSelect; module._unifiedExecutorDeps.runParallelBatch = originalBatch; }
  });

  test("AC-30: two fast-rung budget exhaustions stop at balanced", async () => {
    _tierEscalationDeps.savePRD = mock(async () => {});
    // Two failed fast-rung iterations increment attempts to 2; the next
    // pre-iteration check performs exactly one escalation to balanced.
    const result = await runTierCheck(story({ attempts: 2 }));
    const current = result.prd.userStories[0] as unknown as Loose;
    expect((current.routing as Loose).modelTier).toBe("balanced");
    expect((current.routing as Loose).modelTier).not.toBe("powerful");
  });
});

function pipelineResult(category: string): Loose {
  return { success: false, finalAction: "escalate", reason: "pipeline failed", context: { tddFailureCategory: category, agentResult: { estimatedCostUsd: 0 } }, stageCost: 0 };
}

function pipelineContext(selectedStory = story()): Loose {
  return {
    config: escalationConfig(), prd: prd(selectedStory), prdPath: "/tmp/escalation-correctness-prd.json", workdir: "/tmp", hooks: { hooks: [] }, feature: "escalation-correctness", totalCost: 0, startTime: Date.now(), runId: "run", pluginRegistry: {}, story: selectedStory, storiesToExecute: [selectedStory], routing: { modelTier: "fast", testStrategy: "test-after", complexity: "medium", reasoning: "" }, isBatchExecution: false, allStoryMetrics: [], runtime: { costAggregator: { byStory: () => ({}) } },
  };
}

function executorContext(overrides: Loose = {}): Loose {
  return {
    ...pipelineContext(), config: { ...escalationConfig(), execution: { maxIterations: 1, costLimit: 100, iterationDelayMs: 0 } }, dryRun: false, useBatch: false, batchPlan: [], parallelCount: 0,
    statusWriter: { setPrd: () => {}, setCurrentStory: () => {}, setRunStatus: () => {}, update: async () => {} },
    runtime: { projectKey: "acceptance", outputDir: "/tmp/nax-acceptance", costAggregator: { snapshot: () => ({ totalCostUsd: 0 }), byStory: () => ({}) } },
    ...overrides,
  };
}