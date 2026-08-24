import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { DebateStageConfig } from "@/debate/types";
import type { InteractionBridge } from "@/interaction/bridge-builder";
import { planInteractiveOp } from "@/operations";
import * as operationsModule from "@/operations";
import { DebatePlanStrategy, _debatePlanDeps } from "@/plan";
import type { PlanDeps, PlanModeContext } from "@/plan/strategies";
import type { PRD } from "@/prd/types";
import { PlanPromptBuilder } from "@/prompts";
import type { NaxRuntime } from "@/runtime";
import { assertDefined, firstCall, makeDebateRunner, makeLogger, makeMockRuntime } from "@test/helpers";

function makeRuntime(closeImpl = mock(async () => {})): NaxRuntime {
  const runtime = makeMockRuntime();
  runtime.close = closeImpl;
  return runtime;
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
    createDebateRunner: mock(() => makeDebateRunner()),
    getLogger: makeLogger,
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
    profileName: "default",
    workdir: "/tmp/workdir",
    naxDir: "/tmp/workdir/.nax",
    outputDir: "/tmp/workdir/.nax/features/feat-debate",
    outputPath: "/tmp/workdir/.nax/features/feat-debate/prd.json",
    specContent: "# Spec\nBuild debate planning.",
    codebaseContext: "## Codebase Context\n- src/app.ts",
    normalizedRoots: [],
    relativePackages: ["packages/api"],
    packageDetails: [
      {
        path: "packages/api",
        name: "@acme/api",
        runtime: "bun",
        framework: "oak",
        testRunner: "bun:test",
        keyDeps: [],
      },
    ],
    projectName: "acme",
    branchName: "feat/feat-debate",
    timeoutSeconds: 90,
    config: {
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
    const createDebateRunnerMock = mock(() => makeDebateRunner({ runPlan: runPlanMock }));
    const ctx = makeContext({
      deps: makeDeps({ createDebateRunner: createDebateRunnerMock }),
    });

    const result = await new DebatePlanStrategy().execute(ctx);

    expect(result.outputPath).toBe(ctx.outputPath);
    expect(buildPromptSpy).toHaveBeenCalledWith(
      ctx.specContent,
      ctx.codebaseContext,
      undefined,
      ctx.relativePackages,
      ctx.packageDetails,
      ctx.config.project,
      undefined,
      [],
    );
    assertDefined(ctx.config.debate, "ctx.config.debate");
    expect(_debatePlanDeps.buildPlanComposition).toHaveBeenCalledWith(ctx.config.debate.stages.plan);
    expect(createDebateRunnerMock).toHaveBeenCalledTimes(1);

    const [runnerOptions] = createDebateRunnerMock.mock.calls[0] as unknown as [
      {
        stage: string;
        stageConfig: DebateStageConfig;
        config: unknown;
        workdir: string;
        featureName: string;
        timeoutSeconds: number;
        sessionManager: unknown;
      },
    ];
    expect(runnerOptions.stage).toBe("plan");
    expect(runnerOptions.stageConfig).toEqual({
      enabled: true,
      resolver: { type: "majority-fail-closed" },
      sessionMode: "one-shot",
      rounds: 1,
    });
    expect(runnerOptions.config).toBe(ctx.runtime.configLoader.current());
    expect(runnerOptions.workdir).toBe(ctx.workdir);
    expect(runnerOptions.featureName).toBe(ctx.options.feature);
    expect(runnerOptions.timeoutSeconds).toBe(ctx.timeoutSeconds);
    expect(runnerOptions.sessionManager).toBe(ctx.runtime.sessionManager);

    expect(runPlanMock).toHaveBeenCalledTimes(1);
    const [taskContext, outputFormat, runOpts] = runPlanMock.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
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

  // Debate parity (#1160 follow-up): the synthesis path has no op verify, so the

  test("falls back to callOp with planInteractiveOp and persists via writeOrRecoverPrd when runPlan fails", async () => {
    const fallbackPrd = SAMPLE_PRD;
    const runPlanMock = mock(async () => ({
      outcome: "failed",
      output: "",
    }));
    const createDebateRunnerMock = mock(() => makeDebateRunner({ runPlan: runPlanMock }));
    const callOpSpy = spyOn(operationsModule, "callOp").mockResolvedValue(fallbackPrd as never);
    const origWriteOrRecoverPrd = _debatePlanDeps.writeOrRecoverPrd;
    _debatePlanDeps.writeOrRecoverPrd = mock(async () => ({
      outputPath: "/tmp/workdir/.nax/features/feat-debate/prd.json",
    }));
    const ctx = makeContext({
      deps: makeDeps({ createDebateRunner: createDebateRunnerMock }),
    });

    try {
      const result = await new DebatePlanStrategy().execute(ctx);

      expect(result.outputPath).toBe(ctx.outputPath);
      expect(callOpSpy).toHaveBeenCalledTimes(1);
      const [callCtx, op, input] = firstCall(callOpSpy, "callOp");
      const dispatchedOp: unknown = op;
      expect(dispatchedOp).toBe(planInteractiveOp);
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
        projectProfile: ctx.config.project,
      });
      expect(_debatePlanDeps.writeOrRecoverPrd).toHaveBeenCalledWith(ctx, fallbackPrd);
      expect(ctx.runtime.close).toHaveBeenCalledTimes(1);
    } finally {
      _debatePlanDeps.writeOrRecoverPrd = origWriteOrRecoverPrd;
      mock.restore();
    }
  });
});
