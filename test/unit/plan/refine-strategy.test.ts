import { describe, expect, mock, test } from "bun:test";
import type { InteractionBridge } from "@/interaction/bridge-builder";
import { RefinePlanStrategy, _refinePlanDeps } from "@/plan";
import type { PlanDeps, PlanModeContext } from "@/plan/strategies/types";
import type { PackageSummary } from "@/prompts";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager } from "@test/helpers";

function makeRuntime(closeImpl?: () => Promise<void>): NaxRuntime {
  return {
    packages: { resolve: () => ({}) },
    agentManager: makeMockAgentManager({ getDefaultAgent: "agent-refine" }),
    close: closeImpl ?? (async () => {}),
  } as unknown as NaxRuntime;
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
    getLogger: () => null,
  };
}

function makeCtx(overrides: Partial<PlanModeContext> = {}): PlanModeContext {
  return {
    workdir: "/tmp/workdir",
    naxDir: "/tmp/workdir/.nax",
    outputDir: "/tmp/workdir/.nax/features/feat-x",
    outputPath: "/tmp/workdir/.nax/features/feat-x/prd.json",
    specContent: "# spec",
    codebaseContext: "context",
    normalizedRoots: [],
    relativePackages: ["packages/api"],
    packageDetails: [{ path: "packages/api", packageName: "@acme/api", stackSummary: "TypeScript" } as PackageSummary],
    projectName: "acme",
    branchName: "feat/feat-x",
    timeoutSeconds: 30,
    config: { timeoutSeconds: 30 } as never,
    fullConfig: {} as never,
    options: { from: "/tmp/spec.md", feature: "feat-x" },
    runtime: makeRuntime(),
    interactionChain: null,
    interactionBridge: {} as InteractionBridge,
    deps: makeDeps(),
    ...overrides,
  };
}

describe("RefinePlanStrategy", () => {
  test("mode is refine", () => {
    const strategy = new RefinePlanStrategy();
    expect(strategy.mode).toBe("refine");
  });

  test("calls callOp with planRefineOp and returns outputPath on success", async () => {
    const strategy = new RefinePlanStrategy();
    const ctx = makeCtx();
    const callOpMock = mock(async () => ({ userStories: [{}] }));
    const originalCallOp = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = callOpMock as typeof _refinePlanDeps.callOp;

    try {
      const result = await strategy.execute(ctx);
      expect(result).toBe(ctx.outputPath);
      expect(callOpMock).toHaveBeenCalledTimes(1);
      const [callCtx, operation, input] = callOpMock.mock.calls[0] as [Record<string, unknown>, unknown, Record<string, unknown>];
      expect(callCtx.runtime).toBe(ctx.runtime);
      expect(callCtx.packageDir).toBe(ctx.workdir);
      expect(callCtx.agentName).toBe("agent-refine");
      expect(callCtx.storyId).toBe(ctx.options.feature);
      expect(callCtx.featureName).toBe(ctx.options.feature);
      expect(callCtx.interactionBridge).toBe(ctx.interactionBridge);
      expect(callCtx.maxInteractionTurns).toBe(ctx.fullConfig.agent?.maxInteractionTurns);
      expect(operation).toBe(_refinePlanDeps.planRefineOp);
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
    } finally {
      _refinePlanDeps.callOp = originalCallOp;
    }
  });

  test("returns outputPath when callOp throws and output file already exists", async () => {
    const strategy = new RefinePlanStrategy();
    const ctx = makeCtx({ deps: makeDeps(true) });
    const originalCallOp = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = mock(async () => {
      throw new Error("callOp failed");
    }) as typeof _refinePlanDeps.callOp;

    try {
      await expect(strategy.execute(ctx)).resolves.toBe(ctx.outputPath);
    } finally {
      _refinePlanDeps.callOp = originalCallOp;
    }
  });

  test("does not close runtime in strategy lifecycle", async () => {
    const closeSpy = mock(async () => {});
    const strategy = new RefinePlanStrategy();
    const ctx = makeCtx({ runtime: makeRuntime(closeSpy) });
    const originalCallOp = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = mock(async () => ({ userStories: [{}] })) as typeof _refinePlanDeps.callOp;

    try {
      await strategy.execute(ctx);
      expect(closeSpy).toHaveBeenCalledTimes(0);
    } finally {
      _refinePlanDeps.callOp = originalCallOp;
    }
  });
});
