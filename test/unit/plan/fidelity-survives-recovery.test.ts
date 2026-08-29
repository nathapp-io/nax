/**
 * #1494 — a throw inside a plan strategy diverts it onto its disk-recovery
 * branch, which used to persist the agent-written PRD raw and silently discard
 * every deterministic spec→PRD fidelity repair while still reporting success.
 *
 * `modifiedFiles` is the canary: unlike `outOfScope` it has no prompt-side
 * self-heal turn, so the `applyPlanFidelity` backfill is its only channel. These
 * tests drive the real strategies with a throwing `callOp` and assert the spec's
 * `### Modifies` authority still reaches disk.
 */
import { describe, expect, test } from "bun:test";
import { makeDebateRunner, makeLogger, makeMockAgentManager, makeMockRuntime, makeNaxConfig } from "@test/helpers";
import { planConfigSelector } from "@/config";
import { _refinePlanDeps, _singlePlanDeps, DebatePlanStrategy, RefinePlanStrategy, SinglePlanStrategy } from "@/plan";
import type { PlanDeps, PlanModeContext } from "@/plan/strategies";

const SPEC = `# SPEC-x

## Stories

**US-001**: do a thing

### Modifies

**US-001**
- \`src/alpha.ts\` — add the alpha seam
- \`src/beta.ts\` — wire beta

**US-002**
- \`src/gamma.ts\` — gamma path

## Acceptance Criteria
`;

/** The agent-written PRD as it lands on disk: fidelity repairs not yet applied. */
const DISK_PRD = JSON.stringify({
  userStories: [
    {
      id: "US-001",
      title: "Do a thing",
      description: "A story the spec grants modification authority for",
      acceptanceCriteria: ["AC1: should pass"],
      complexity: "simple",
    },
    {
      id: "US-002",
      title: "Do another thing",
      description: "A second story the spec grants modification authority for",
      acceptanceCriteria: ["AC1: should pass"],
      complexity: "simple",
    },
  ],
});

function makeCtx(written: { value: string | null }): PlanModeContext {
  const deps: PlanDeps = {
    readFile: async () => DISK_PRD,
    writeFile: async (_path: string, content: string) => {
      written.value = content;
    },
    mkdirp: async () => {},
    existsSync: () => true,
    readPackageJson: async () => null,
    readPackageJsonAt: async () => null,
    scanSourceRoots: async () => [],
    spawnSync: () => ({ stdout: Buffer.from(""), exitCode: 0 }),
    initInteractionChain: async () => null,
    createInteractionBridge: () => ({ detectQuestion: async () => false, onQuestionDetected: async () => "" }),
    createDebateRunner: () =>
      makeDebateRunner({
        runPlan: async () => {
          throw new Error("debate stage failed");
        },
      }),
    getLogger: () => makeLogger(),
  };

  return {
    workdir: "/tmp/workdir",
    naxDir: "/tmp/workdir/.nax",
    outputDir: "/tmp/workdir/.nax/features/feat-x",
    outputPath: "/tmp/workdir/.nax/features/feat-x/prd.json",
    specContent: SPEC,
    codebaseContext: "context",
    normalizedRoots: [],
    relativePackages: ["packages/api"],
    packageDetails: [
      {
        path: "packages/api",
        name: "@acme/api",
        runtime: "node",
        framework: "none",
        testRunner: "bun",
        keyDeps: [],
      },
    ],
    projectName: "acme",
    branchName: "feat/feat-x",
    timeoutSeconds: 30,
    config: makeNaxConfig({ plan: { specGuard: false } }),
    profileName: undefined,
    options: { from: "/tmp/spec.md", feature: "feat-x" },
    runtime: makeMockRuntime({ agentManager: makeMockAgentManager({ getDefaultAgent: "agent-x" }) }),
    interactionChain: null,
    interactionBridge: {
      detectQuestion: async () => false,
      onQuestionDetected: async () => "",
    },
    deps,
  };
}

function expectModifiedFilesSurvived(written: { value: string | null }): void {
  expect(written.value).not.toBeNull();
  const persisted = JSON.parse(written.value as string);
  expect(persisted.userStories[0].modifiedFiles?.map((entry: { path: string }) => entry.path)).toEqual([
    "src/alpha.ts",
    "src/beta.ts",
  ]);
  expect(persisted.userStories[1].modifiedFiles?.map((entry: { path: string }) => entry.path)).toEqual([
    "src/gamma.ts",
  ]);
}

describe("#1494 — fidelity repairs survive the disk-recovery path", () => {
  test("refine: a throw still persists the spec's Modifies authority", async () => {
    const written = { value: null as string | null };
    const ctx = makeCtx(written);
    const original = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = (async () => {
      throw new Error("agent call failed");
    }) as typeof _refinePlanDeps.callOp;

    try {
      const result = await new RefinePlanStrategy().execute(ctx);
      expect(result.outputPath).toBe(ctx.outputPath);
      expect(result.degraded?.reason).toBe("agent call failed");
    } finally {
      _refinePlanDeps.callOp = original;
    }
    expectModifiedFilesSurvived(written);
  });

  test("single: a throw still persists the spec's Modifies authority", async () => {
    const written = { value: null as string | null };
    const ctx = makeCtx(written);
    const original = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = (async () => {
      throw new Error("agent call failed");
    }) as typeof _singlePlanDeps.callOp;

    try {
      const result = await new SinglePlanStrategy().execute(ctx);
      expect(result.outputPath).toBe(ctx.outputPath);
      expect(result.degraded?.reason).toBe("agent call failed");
    } finally {
      _singlePlanDeps.callOp = original;
    }
    expectModifiedFilesSurvived(written);
  });

  test("debate: a throw still persists the spec's Modifies authority", async () => {
    const written = { value: null as string | null };
    const ctx = makeCtx(written);
    // The debate runner throws inside execute's try — the same recovery branch
    // refine takes, reached through writeOrRecoverPrd.
    const ctxWithStage: PlanModeContext = {
      ...ctx,
      config: planConfigSelector.select(
        makeNaxConfig({ plan: { specGuard: false }, debate: { stages: { plan: { enabled: true } } } }),
      ),
    };

    const result = await new DebatePlanStrategy().execute(ctxWithStage);
    expect(result.outputPath).toBe(ctx.outputPath);
    expect(result.degraded?.reason).toBe("debate stage failed");
    expectModifiedFilesSurvived(written);
  });

  test("the repair is applied on the happy path too", async () => {
    const written = { value: null as string | null };
    const ctx = makeCtx(written);
    const original = _refinePlanDeps.callOp;
    _refinePlanDeps.callOp = (async () => JSON.parse(DISK_PRD)) as typeof _refinePlanDeps.callOp;

    try {
      const result = await new RefinePlanStrategy().execute(ctx);
      expect(result.outputPath).toBe(ctx.outputPath);
      // A clean plan must NOT be labelled degraded — otherwise the CLI warning
      // becomes noise the user learns to ignore.
      expect(result.degraded).toBeUndefined();
    } finally {
      _refinePlanDeps.callOp = original;
    }
    expectModifiedFilesSurvived(written);
  });
});
