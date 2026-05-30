import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { planInteractiveOp } from "@/operations";
import * as operationsModule from "@/operations";
import { DebatePlanStrategy, _debatePlanDeps } from "@/plan";
import type { PlanDeps, PlanModeContext } from "@/plan/strategies";
import type { DebateStageConfig } from "@/debate/types";
import type { InteractionBridge } from "@/interaction/bridge-builder";
import type { NaxRuntime } from "@/runtime";
import type { PRD } from "@/prd/types";
import { PlanPromptBuilder } from "@/prompts";
import { makeMockAgentManager } from "@test/helpers";

function makeRuntime(closeImpl = mock(async () => {})): NaxRuntime {
  return {
    runId: "run-123",
    configLoader: {} as never,
    workdir: "/tmp/workdir",
    projectDir: "/tmp/workdir",
    outputDir: "/tmp/workdir/.nax",
    globalDir: "/tmp/global",
    curatorRollupPath: "/tmp/global/curator/rollup.jsonl",
    projectKey: "project-key",
    agentManager: makeMockAgentManager({ getDefaultAgent: "claude" }),
    sessionManager: { nameFor: () => "session" } as never,
    costAggregator: {} as never,
    promptAuditor: {} as never,
    reviewAuditor: {} as never,
    dispatchEvents: {} as never,
    agentStreamEvents: {} as never,
    packages: { resolve: () => ({ id: "package-view" }) } as never,
    pidRegistry: {} as never,
    logger: {} as never,
    signal: new AbortController().signal,
    close: closeImpl,
  };
}

function makeDeps(overrides: Partial<PlanDeps> = {}): PlanDeps {
  return {
    readFile: mock(async () => ""),
    writeFile: mock(async () => {}),
    mkdirp: mock(async () => {}),
    existsSync: mock(() => false),
    readPackageJson: mock(async () => null),
    readPackageJsonAt: mock(async () => null),
    scanSourceRoots: mock(async () => []),
    spawnSync: mock(() => ({ stdout: Buffer.from(""), exitCode: 0 })),
    initInteractionChain: mock(async () => null),
    createInteractionBridge: mock(() => ({
      detectQuestion: async () => false,
      onQuestionDetected: async () => "",
    })),
    createDebateRunner: mock(() => ({ runPlan: mock(async () => ({ outcome: "failed" })) } as never)),
    ...overrides,
  };
}

function makeContext(overrides: Partial<PlanModeContext> = {}): PlanModeContext {
  const planStageConfig: DebateStageConfig = {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    rounds: 1,
  };
  const runtime = makeRuntime();
  const deps = makeDeps();

  return {
    workdir: "/tmp/workdir",
    naxDir: "/tmp/workdir/.nax",
    outputDir: "/tmp/workdir/.nax/features/feat-debate",
    outputPath: "/tmp/workdir/.nax/features/feat-debate/prd.json",
    specContent: "# Spec\nBuild debate planning.",
    codebaseContext: "## Codebase Context\n- src/app.ts",
    normalizedRoots: [],
    relativePackages: ["packages/api"],
    packageDetails: [{ path: "packages/api", name: "@acme/api", runtime: "bun", framework: "oak", testRunner: "bun:test", keyDeps: [] }],
    projectName: "acme",
    branchName: "feat/feat-debate",
    timeoutSeconds: 90,
    config: {
      debate: { stages: { plan: planStageConfig } },
    } as never,
    fullConfig: {
      debate: { stages: { plan: planStageConfig } },
      agent: { maxInteractionTurns: 7 },
      project: { kind: "sentinel" },
    } as never,
    options: { from: "/tmp/spec.md", feature: "feat-debate" },
    runtime,
    interactionChain: null,
    interactionBridge: {} as InteractionBridge,
    deps,
    ...overrides,
  };
}

const SAMPLE_PRD: PRD = {
  project: "acme",
  feature: "feat-debate",
  branchName: "feat/feat-debate",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Plan debate",
      description: "Generate a debated plan",
      acceptanceCriteria: ["The plan is produced"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "sentinel",
      },
    },
  ],
};

describe("DebatePlanStrategy", () => {
  let buildPromptSpy: ReturnType<typeof spyOn>;
  let origBuildPlanComposition: typeof _debatePlanDeps.buildPlanComposition;

  beforeEach(() => {
    buildPromptSpy = spyOn(PlanPromptBuilder.prototype, "build").mockReturnValue({
      taskContext: "TASK_CONTEXT",
      outputFormat: "OUTPUT_FORMAT",
    });
    origBuildPlanComposition = _debatePlanDeps.buildPlanComposition;
    _debatePlanDeps.buildPlanComposition = mock((stageConfig) => ({
      ...stageConfig,
      rounds: stageConfig.rounds,
    }));
  });

  afterEach(() => {
    mock.restore();
    _debatePlanDeps.buildPlanComposition = origBuildPlanComposition;
  });

  test("mode is debate", () => {
    expect(new DebatePlanStrategy().mode).toBe("debate");
  });

  test("calls createDebateRunner with the plan stage config and runs the debate prompt through runPlan", async () => {
    const runPlanMock = mock(async () => ({ outcome: "passed", output: JSON.stringify(SAMPLE_PRD) }));
    const createDebateRunnerMock = mock(() => ({ runPlan: runPlanMock }));
    const ctx = makeContext({
      deps: makeDeps({ createDebateRunner: createDebateRunnerMock }),
    });

    const result = await new DebatePlanStrategy().execute(ctx);

    expect(result).toBe(ctx.outputPath);
    expect(buildPromptSpy).toHaveBeenCalledWith(
      ctx.specContent,
      ctx.codebaseContext,
      undefined,
      ctx.relativePackages,
      ctx.packageDetails,
      ctx.fullConfig.project,
    );
    expect(_debatePlanDeps.buildPlanComposition).toHaveBeenCalledWith(ctx.config.debate.stages.plan);
    expect(createDebateRunnerMock).toHaveBeenCalledTimes(1);

    const [runnerOptions] = createDebateRunnerMock.mock.calls[0] as unknown as [{ stage: string; stageConfig: DebateStageConfig; config: typeof ctx.fullConfig; workdir: string; featureName: string; timeoutSeconds: number; sessionManager: unknown }];
    expect(runnerOptions.stage).toBe("plan");
    expect(runnerOptions.stageConfig).toEqual({
      enabled: true,
      resolver: { type: "majority-fail-closed" },
      sessionMode: "one-shot",
      rounds: 1,
    });
    expect(runnerOptions.config).toBe(ctx.fullConfig);
    expect(runnerOptions.workdir).toBe(ctx.workdir);
    expect(runnerOptions.featureName).toBe(ctx.options.feature);
    expect(runnerOptions.timeoutSeconds).toBe(ctx.timeoutSeconds);
    expect(runnerOptions.sessionManager).toBe(ctx.runtime.sessionManager);

    expect(runPlanMock).toHaveBeenCalledTimes(1);
    const [taskContext, outputFormat, runOpts] = runPlanMock.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(taskContext).toBe("TASK_CONTEXT");
    expect(outputFormat).toBe("OUTPUT_FORMAT");
    expect(runOpts).toEqual({
      workdir: ctx.workdir,
      feature: ctx.options.feature,
      outputDir: ctx.outputDir,
      timeoutSeconds: ctx.timeoutSeconds,
      maxInteractionTurns: 7,
      specContent: ctx.specContent,
    });
    expect(ctx.runtime.close).toHaveBeenCalledTimes(1);
  });

  async function withWarnSpy<T>(fn: (warnSpy: ReturnType<typeof spyOn>) => Promise<T>): Promise<T> {
    const { resetLogger, initLogger } = await import("@/logger");
    resetLogger();
    const warnSpy = spyOn(initLogger({ level: "silent" }), "warn");
    try {
      return await fn(warnSpy);
    } finally {
      warnSpy.mockRestore();
      resetLogger();
    }
  }

  function verbatimWarn(warnSpy: ReturnType<typeof spyOn>) {
    return warnSpy.mock.calls.find((c) => c[0] === "plan" && String(c[1]).includes("[verbatim]"));
  }

  // Debate parity (#1160 follow-up): the synthesis path has no op verify, so the
  // strategy must warn directly when synthesis drops a [verbatim] spec AC.
  test("warns when the synthesis PRD drops a [verbatim] spec AC", async () => {
    const runPlanMock = mock(async () => ({ outcome: "passed", output: JSON.stringify(SAMPLE_PRD) }));
    const ctx = makeContext({
      specContent: '- [verbatim] `grep -rn "gone" src/` returns zero matches',
      deps: makeDeps({ createDebateRunner: mock(() => ({ runPlan: runPlanMock })) }),
    });

    await withWarnSpy(async (warnSpy) => {
      await new DebatePlanStrategy().execute(ctx);
      const warn = verbatimWarn(warnSpy);
      expect(warn).toBeDefined();
      expect((warn?.[2] as { missingCount: number }).missingCount).toBe(1);
    });
  });

  test("does not warn when the synthesis PRD preserves the [verbatim] spec AC", async () => {
    const runPlanMock = mock(async () => ({ outcome: "passed", output: JSON.stringify(SAMPLE_PRD) }));
    const ctx = makeContext({
      // SAMPLE_PRD's only AC is "The plan is produced" — match it verbatim.
      specContent: "- [verbatim] The plan is produced",
      deps: makeDeps({ createDebateRunner: mock(() => ({ runPlan: runPlanMock })) }),
    });

    await withWarnSpy(async (warnSpy) => {
      await new DebatePlanStrategy().execute(ctx);
      expect(verbatimWarn(warnSpy)).toBeUndefined();
    });
  });

  test("falls back to callOp with planInteractiveOp and persists via writeOrRecoverPrd when runPlan fails", async () => {
    const fallbackPrd = SAMPLE_PRD;
    const runPlanMock = mock(async () => ({
      outcome: "failed",
      output: "",
    }));
    const createDebateRunnerMock = mock(() => ({ runPlan: runPlanMock }));
    const callOpSpy = spyOn(operationsModule, "callOp").mockResolvedValue(fallbackPrd as never);
    const origWriteOrRecoverPrd = _debatePlanDeps.writeOrRecoverPrd;
    _debatePlanDeps.writeOrRecoverPrd = mock(async () => "/tmp/workdir/.nax/features/feat-debate/prd.json");
    const ctx = makeContext({
      deps: makeDeps({ createDebateRunner: createDebateRunnerMock }),
    });

    try {
      const result = await new DebatePlanStrategy().execute(ctx);

      expect(result).toBe(ctx.outputPath);
      expect(callOpSpy).toHaveBeenCalledTimes(1);
      const [callCtx, op, input] = callOpSpy.mock.calls[0] as [Record<string, unknown>, unknown, Record<string, unknown>];
      expect(op).toBe(planInteractiveOp);
      expect(callCtx.runtime).toBe(ctx.runtime);
      expect(callCtx.packageDir).toBe(ctx.workdir);
      expect(callCtx.storyId).toBe(ctx.options.feature);
      expect(callCtx.featureName).toBe(ctx.options.feature);
      expect(input).toEqual({
        specContent: ctx.specContent,
        codebaseContext: ctx.codebaseContext,
        featureName: ctx.options.feature,
        branchName: ctx.branchName,
        outputPath: ctx.outputPath,
        packages: ctx.relativePackages,
        packageDetails: ctx.packageDetails,
        projectProfile: ctx.fullConfig.project,
      });
      expect(_debatePlanDeps.writeOrRecoverPrd).toHaveBeenCalledWith(ctx, fallbackPrd);
      expect(ctx.runtime.close).toHaveBeenCalledTimes(1);
    } finally {
      _debatePlanDeps.writeOrRecoverPrd = origWriteOrRecoverPrd;
      mock.restore();
    }
  });
});
