import { describe, expect, mock, test } from "bun:test";
import { NaxError } from "@/errors";
import { PipelinePlanStrategy, _pipelinePlanDeps } from "@/plan";
import type { PlanModeContext } from "@/plan/strategies/types";
import type { PackageSummary } from "@/prompts";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager } from "@test/helpers";

function makeRuntime(closeImpl?: () => Promise<void>): NaxRuntime {
  return {
    runId: "run-1",
    configLoader: { current: () => ({}) as never },
    packages: { resolve: () => ({}) },
    agentManager: makeMockAgentManager({ getDefaultAgent: "agent-pipeline" }),
    close: closeImpl ?? (async () => {}),
  } as unknown as NaxRuntime;
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
    config: { citationThreshold: 0.55, plan: { citationThreshold: 0.55 }, project: { language: "ts" } } as never,
    options: { from: "/tmp/spec.md", feature: "feat-x" },
    runtime: makeRuntime(),
    interactionChain: null,
    interactionBridge: { detectQuestion: async () => false, onQuestionDetected: async () => "" },
    deps: {
      readFile: async () => "",
      writeFile: async () => {},
      mkdirp: async () => {},
      existsSync: () => false,
      readPackageJson: async () => null,
      readPackageJsonAt: async () => null,
      scanSourceRoots: async () => [],
      spawnSync: () => ({ stdout: Buffer.from(""), exitCode: 0 }),
      initInteractionChain: async () => null,
      createInteractionBridge: () => ({ detectQuestion: async () => false, onQuestionDetected: async () => "" }),
      createDebateRunner: () => ({}) as never,
    },
    ...overrides,
  };
}

describe("PipelinePlanStrategy", () => {
  test("AC1/AC3/AC4: calls ground then draft then critic and maps draft input fields", async () => {
    const strategy = new PipelinePlanStrategy();
    const ctx = makeCtx();
    const sequence: string[] = [];

    const originalCallOp = _pipelinePlanDeps.callOp;
    const originalRunPlanCritic = _pipelinePlanDeps.runPlanCritic;
    _pipelinePlanDeps.callOp = mock(async (_callCtx, op, input) => {
      if (op === _pipelinePlanDeps.groundOp) {
        sequence.push("ground");
        return { repoFacts: [], specClaims: [], gaps: [] };
      }
      if (op === _pipelinePlanDeps.planDraftOp) {
        sequence.push("draft");
        expect(input.projectProfile).toBe(ctx.config.project);
        expect(input.packages).toEqual(ctx.relativePackages);
        expect(input.packageDetails).toEqual(ctx.packageDetails);
        return { prd: { userStories: [] } };
      }
      throw new Error("unexpected op");
    }) as typeof _pipelinePlanDeps.callOp;
    _pipelinePlanDeps.runPlanCritic = mock(async () => {
      sequence.push("critic");
      return { outcome: "passed", prd: { userStories: [] }, findings: [] };
    }) as typeof _pipelinePlanDeps.runPlanCritic;

    try {
      const { outputPath } = await strategy.execute(ctx);
      expect(outputPath).toBe(ctx.outputPath);
      expect(sequence).toEqual(["ground", "draft", "critic"]);
    } finally {
      _pipelinePlanDeps.callOp = originalCallOp;
      _pipelinePlanDeps.runPlanCritic = originalRunPlanCritic;
    }
  });

  test("AC2: throws NaxError PLAN_CRITIC_BLOCKED when critic verdict is failed", async () => {
    const strategy = new PipelinePlanStrategy();
    const ctx = makeCtx();

    const originalCallOp = _pipelinePlanDeps.callOp;
    const originalRunPlanCritic = _pipelinePlanDeps.runPlanCritic;
    _pipelinePlanDeps.callOp = mock(async (_callCtx, op) => {
      if (op === _pipelinePlanDeps.groundOp) return { repoFacts: [], specClaims: [], gaps: [] };
      return { prd: { userStories: [] } };
    }) as typeof _pipelinePlanDeps.callOp;
    _pipelinePlanDeps.runPlanCritic = mock(async () => {
      return { outcome: "failed", prd: { userStories: [] }, findings: [], specDeltasPath: "/tmp/spec-deltas.md" };
    }) as typeof _pipelinePlanDeps.runPlanCritic;

    try {
      await expect(strategy.execute(ctx)).rejects.toMatchObject({
        name: NaxError.name,
        code: "PLAN_CRITIC_BLOCKED",
      });
    } finally {
      _pipelinePlanDeps.callOp = originalCallOp;
      _pipelinePlanDeps.runPlanCritic = originalRunPlanCritic;
    }
  });

  test("AC5: mode is pipeline", () => {
    const strategy = new PipelinePlanStrategy();
    expect(strategy.mode).toBe("pipeline");
  });

  test("ADR-025: finalizePrdRouting applied on write — resolves agentProfileId and stamps routingProfile", async () => {
    const strategy = new PipelinePlanStrategy();
    let writtenContent = "";
    const ctx = makeCtx({
      profileName: "team-a",
      config: {
        citationThreshold: 0.55,
        plan: { citationThreshold: 0.55 },
        project: { language: "ts" },
        routing: {
          agents: {
            enabled: true,
            profiles: [{ id: "senior", target: { agent: "claude", model: "powerful" } }],
          },
        },
      } as never,
      deps: {
        readFile: async () => "",
        writeFile: async (_path: string, content: string) => {
          writtenContent = content;
        },
        mkdirp: async () => {},
        existsSync: () => false,
        readPackageJson: async () => null,
        readPackageJsonAt: async () => null,
        scanSourceRoots: async () => [],
        spawnSync: () => ({ stdout: Buffer.from(""), exitCode: 0 }),
        initInteractionChain: async () => null,
        createInteractionBridge: () => ({ detectQuestion: async () => false, onQuestionDetected: async () => "" }),
        createDebateRunner: () => ({}) as never,
      },
    });

    const originalCallOp = _pipelinePlanDeps.callOp;
    const originalRunPlanCritic = _pipelinePlanDeps.runPlanCritic;
    _pipelinePlanDeps.callOp = mock(async (_callCtx, op) => {
      if (op === _pipelinePlanDeps.groundOp) return { repoFacts: [], specClaims: [], gaps: [] };
      return {
        prd: {
          userStories: [
            {
              id: "s1",
              title: "story 1",
              description: "",
              acceptanceCriteria: [],
              status: "pending",
              passes: false,
              escalations: [],
              attempts: 0,
              routing: {
                complexity: "low",
                testStrategy: "test-after",
                reasoning: "",
                agentProfileId: "senior",
              },
            },
          ],
        },
      };
    }) as typeof _pipelinePlanDeps.callOp;
    _pipelinePlanDeps.runPlanCritic = mock(async () => ({
      outcome: "passed",
      prd: {
        userStories: [
          {
            id: "s1",
            title: "story 1",
            description: "",
            acceptanceCriteria: [],
            status: "pending",
            passes: false,
            escalations: [],
            attempts: 0,
            routing: {
              complexity: "low",
              testStrategy: "test-after",
              reasoning: "",
              agentProfileId: "senior",
            },
          },
        ],
      },
      findings: [],
    })) as typeof _pipelinePlanDeps.runPlanCritic;

    try {
      await strategy.execute(ctx);
      const prd = JSON.parse(writtenContent);
      expect(prd.routingProfile).toBe("team-a");
      expect(prd.userStories[0].routing.agent).toBe("claude");
      expect(prd.userStories[0].routing.profileModelTier).toBe("powerful");
      expect(prd.userStories[0].routing.initialAgent).toBe("claude");
    } finally {
      _pipelinePlanDeps.callOp = originalCallOp;
      _pipelinePlanDeps.runPlanCritic = originalRunPlanCritic;
    }
  });

  test("AC6: runtime.close is called in finally on success and failure", async () => {
    const closeSuccess = mock(async () => {});
    const closeFailure = mock(async () => {});

    const strategy = new PipelinePlanStrategy();
    const successCtx = makeCtx({
      runtime: makeRuntime(closeSuccess),
      outputPath: "/tmp/workdir/.nax/features/feat-success/prd.json",
    });
    const failureCtx = makeCtx({
      runtime: makeRuntime(closeFailure),
      outputPath: "/tmp/workdir/.nax/features/feat-failure/prd.json",
      options: { from: "/tmp/spec.md", feature: "feat-failure" },
    });

    const originalCallOp = _pipelinePlanDeps.callOp;
    const originalRunPlanCritic = _pipelinePlanDeps.runPlanCritic;
    _pipelinePlanDeps.callOp = mock(async (_callCtx, op, input) => {
      if (op === _pipelinePlanDeps.groundOp) return { repoFacts: [], specClaims: [], gaps: [] };
      if (input.feature === failureCtx.options.feature) {
        throw new Error("draft failed");
      }
      return { prd: { userStories: [] } };
    }) as typeof _pipelinePlanDeps.callOp;
    _pipelinePlanDeps.runPlanCritic = mock(async () => {
      return { outcome: "passed", prd: { userStories: [] }, findings: [] };
    }) as typeof _pipelinePlanDeps.runPlanCritic;

    try {
      await strategy.execute(successCtx);
      await expect(strategy.execute(failureCtx)).rejects.toThrow("draft failed");
      expect(closeSuccess).toHaveBeenCalledTimes(1);
      expect(closeFailure).toHaveBeenCalledTimes(1);
    } finally {
      _pipelinePlanDeps.callOp = originalCallOp;
      _pipelinePlanDeps.runPlanCritic = originalRunPlanCritic;
    }
  });
});
