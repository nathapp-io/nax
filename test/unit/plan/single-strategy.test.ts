import { describe, expect, mock, test } from "bun:test";
import { firstCall, makeLogger, makeMockAgentManager, makeMockRuntime } from "@test/helpers";
import type { InteractionBridge } from "@/interaction/bridge-builder";
import { _singlePlanDeps, SinglePlanStrategy } from "@/plan";
import type { PlanDeps, PlanModeContext } from "@/plan/strategies/types";
import type { PackageSummary } from "@/prompts";
import type { NaxRuntime } from "@/runtime";

function makeRuntime(closeImpl?: () => Promise<void>): NaxRuntime {
  const runtime = makeMockRuntime({
    agentManager: makeMockAgentManager({ getDefaultAgent: "agent-single" }),
  });
  if (closeImpl) runtime.close = closeImpl;
  return runtime;
}

const VALID_PRD_JSON = JSON.stringify({
  userStories: [
    {
      id: "US-001",
      title: "Recovered story",
      description: "A recovered story for disk-recovery testing",
      acceptanceCriteria: ["AC1: should pass"],
      complexity: "simple",
    },
  ],
});

function makeDeps(exists = false): PlanDeps {
  return {
    readFile: async () => (exists ? VALID_PRD_JSON : ""),
    writeFile: async () => {},
    mkdirp: async () => {},
    existsSync: () => exists,
    readPackageJson: async () => null,
    readPackageJsonAt: async () => null,
    scanSourceRoots: async () => [],
    spawnSync: () => ({ stdout: Buffer.from(""), exitCode: 0 }),
    initInteractionChain: async () => null,
    createInteractionBridge: () => ({
      detectQuestion: async () => false,
      onQuestionDetected: async () => "",
    }),
    createDebateRunner: () => ({}) as never,
    getLogger: makeLogger,
  };
}

function makeCtx(overrides: Partial<PlanModeContext> = {}): PlanModeContext {
  return {
    profileName: "default",
    workdir: "/tmp/workdir",
    naxDir: "/tmp/workdir/.nax",
    outputDir: "/tmp/workdir/.nax/features/feat-x",
    outputPath: "/tmp/workdir/.nax/features/feat-x/prd.json",
    specContent: "# spec",
    codebaseContext: "context",
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
    branchName: "feat/feat-x",
    timeoutSeconds: 30,
    config: { timeoutSeconds: 30 } as never,
    options: { from: "/tmp/spec.md", feature: "feat-x" },
    runtime: makeRuntime(),
    interactionChain: null,
    interactionBridge: {} as InteractionBridge,
    deps: makeDeps(),
    ...overrides,
  };
}

describe("SinglePlanStrategy", () => {
  test("AC1/AC2: calls callOp with planInteractiveOp and mapped input fields, then returns outputPath", async () => {
    const strategy = new SinglePlanStrategy();
    const ctx = makeCtx();
    const callOpMock = mock(async (..._args: Parameters<typeof _singlePlanDeps.callOp>) => ({ userStories: [{}] }));
    const originalCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = callOpMock as typeof _singlePlanDeps.callOp;

    try {
      const result = await strategy.execute(ctx);
      expect(result.outputPath).toBe(ctx.outputPath);
      expect(callOpMock).toHaveBeenCalledTimes(1);
      const [callCtx, operation, input] = firstCall(callOpMock, "callOp");
      const dispatchedOp: unknown = operation;
      expect(callCtx.runtime).toBe(ctx.runtime);
      expect(callCtx.packageDir).toBe(ctx.workdir);
      expect(callCtx.agentName).toBe("agent-single");
      expect(callCtx.storyId).toBe(ctx.options.feature);
      expect(callCtx.featureName).toBe(ctx.options.feature);
      expect(callCtx.interactionBridge).toBe(ctx.interactionBridge);
      expect(callCtx.maxInteractionTurns).toBe(ctx.config.agent?.maxInteractionTurns);
      expect(dispatchedOp).toBe(_singlePlanDeps.planInteractiveOp);
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
    } finally {
      _singlePlanDeps.callOp = originalCallOp;
    }
  });

  test("AC3: returns outputPath when callOp throws and output file already exists", async () => {
    const strategy = new SinglePlanStrategy();
    const ctx = makeCtx({
      deps: makeDeps(true),
    });
    const originalCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = mock(async () => {
      throw new Error("callOp failed");
    }) as typeof _singlePlanDeps.callOp;

    try {
      await expect(strategy.execute(ctx)).resolves.toMatchObject({ outputPath: ctx.outputPath });
    } finally {
      _singlePlanDeps.callOp = originalCallOp;
    }
  });

  test("rethrows when callOp throws and output file does not exist", async () => {
    const strategy = new SinglePlanStrategy();
    const ctx = makeCtx({
      deps: makeDeps(false),
    });
    const originalCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = mock(async () => {
      throw new Error("callOp failed");
    }) as typeof _singlePlanDeps.callOp;

    try {
      await expect(strategy.execute(ctx)).rejects.toThrow("callOp failed");
    } finally {
      _singlePlanDeps.callOp = originalCallOp;
    }
  });

  test("AC4: mode is single", () => {
    const strategy = new SinglePlanStrategy();
    expect(strategy.mode).toBe("single");
  });

  test("AC5: closes runtime in finally on success and failure", async () => {
    const closeSuccess = mock(async () => {});
    const closeFailure = mock(async () => {});
    const strategy = new SinglePlanStrategy();
    const successCtx = makeCtx({
      runtime: makeRuntime(closeSuccess),
      outputPath: "/tmp/workdir/.nax/features/feat-success/prd.json",
    });
    const failureCtx = makeCtx({ runtime: makeRuntime(closeFailure), deps: makeDeps(false) });
    const originalCallOp = _singlePlanDeps.callOp;
    const callOpMock = mock(async (_callCtx: unknown, _op: unknown, input: { outputPath: string }) => {
      if (input.outputPath === failureCtx.outputPath) throw new Error("boom");
      return { userStories: [{}] };
    });
    _singlePlanDeps.callOp = callOpMock as typeof _singlePlanDeps.callOp;

    try {
      await strategy.execute(successCtx);
      await expect(strategy.execute(failureCtx)).rejects.toThrow("boom");
      expect(closeSuccess).toHaveBeenCalledTimes(1);
      expect(closeFailure).toHaveBeenCalledTimes(1);
    } finally {
      _singlePlanDeps.callOp = originalCallOp;
    }
  });
});
