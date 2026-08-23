import { describe, expect, mock, test } from "bun:test";
import { SinglePlanStrategy, _singlePlanDeps } from "@/plan";
import type { PlanModeContext } from "@/plan/strategies";
import type { PRD } from "@/prd/types";
import { makeLogger, makeMockRuntime, makeNaxConfig, makePRD } from "@test/helpers";

// Minimal PRD returned by the stubbed callOp
function makePrd(agentProfileId?: string): PRD {
  return makePRD({
    project: "p",
    feature: "my-feature",
    branchName: "feat/my-feature",
    userStories: [
      {
        id: "US-001",
        title: "t",
        description: "d",
        acceptanceCriteria: ["a"],
        tags: [],
        dependencies: [],
        status: "pending",
        passes: false,
        attempts: 0,
        escalations: [],
        routing: {
          complexity: "medium",
          testStrategy: "tdd-simple",
          reasoning: "r",
          ...(agentProfileId ? { agentProfileId } : {}),
        },
      },
    ],
  });
}

// Minimal PlanModeContext builder
function makeCtx(overrides: {
  profileName?: string;
  agentRouting?: object;
  writeFile?: (path: string, content: string) => Promise<void>;
  existsSync?: (path: string) => boolean;
}): PlanModeContext {
  const config = makeNaxConfig({
    routing: {
      agents: {
        enabled: true,
        strategy: "off",
        default: "opencode-structural",
        profiles: [
          { id: "opencode-structural", target: { agent: "opencode", model: "fast" }, strengths: ["mechanical"] },
          { id: "claude-final", target: { agent: "claude", model: "balanced" }, strengths: ["design"] },
        ],
        ...(overrides.agentRouting ?? {}),
      },
    },
  }) as unknown as PlanModeContext["config"];

  const fakeRuntime = makeMockRuntime();

  return {
    workdir: "/tmp/test",
    naxDir: "/tmp/test/.nax",
    outputDir: "/tmp/test/.nax/features/my-feature",
    outputPath: "/tmp/test/.nax/features/my-feature/prd.json",
    specContent: "spec",
    codebaseContext: "ctx",
    normalizedRoots: [],
    relativePackages: [],
    packageDetails: [],
    projectName: "my-project",
    branchName: "feat/my-feature",
    timeoutSeconds: 60,
    config,
    profileName: overrides.profileName,
    options: { from: "spec.md", feature: "my-feature" },
    runtime: fakeRuntime,
    interactionChain: null,
    interactionBridge: {} as PlanModeContext["interactionBridge"],
    deps: {
      readFile: async () => "",
      writeFile: overrides.writeFile ?? (async () => {}),
      mkdirp: async () => {},
      existsSync: overrides.existsSync ?? (() => false),
      readPackageJson: async () => null,
      readPackageJsonAt: async () => null,
      scanSourceRoots: async () => [],
      spawnSync: () => ({ stdout: Buffer.from(""), exitCode: 0 }),
      initInteractionChain: async () => null,
      createInteractionBridge: () => ({}) as PlanModeContext["interactionBridge"],
      createDebateRunner: () => ({}) as ReturnType<PlanModeContext["deps"]["createDebateRunner"]>,
      getLogger: () => makeLogger(),
    },
  };
}

describe("SinglePlanStrategy", () => {
  test("resolves agentProfileId and writes routingProfile (finalizePrdRouting applied)", async () => {
    let writtenJson = "";
    const writeFile = async (_path: string, content: string) => {
      writtenJson = content;
    };

    const ctx = makeCtx({ profileName: "cross-agent", writeFile });

    // Stub callOp to return a PRD with agentProfileId "claude-final"
    const origCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = mock(async () => makePrd("claude-final")) as typeof origCallOp;

    try {
      const strategy = new SinglePlanStrategy();
      await strategy.execute(ctx);
    } finally {
      _singlePlanDeps.callOp = origCallOp;
    }

    const prd = JSON.parse(writtenJson) as PRD;
    expect(prd.routingProfile).toBe("cross-agent");
    expect(prd.userStories[0].routing?.agent).toBe("claude");
  });

  test("still writes PRD successfully without routing agents config", async () => {
    let writtenJson = "";
    const writeFile = async (_path: string, content: string) => {
      writtenJson = content;
    };

    const ctx = makeCtx({ profileName: undefined, writeFile });

    const origCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = mock(async () => makePrd()) as typeof origCallOp;

    try {
      const strategy = new SinglePlanStrategy();
      await strategy.execute(ctx);
    } finally {
      _singlePlanDeps.callOp = origCallOp;
    }

    const prd = JSON.parse(writtenJson) as PRD;
    // Without profileName, routingProfile defaults to "default"
    expect(prd.routingProfile).toBe("default");
    expect(prd.project).toBe("my-project");
  });
});
