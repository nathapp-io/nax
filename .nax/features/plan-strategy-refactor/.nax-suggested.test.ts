import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config";
import { planConfigSelector } from "../../../src/config/selectors";
import { NaxError } from "../../../src/errors";
import type { NaxRuntime } from "../../../src/runtime";
import { DEFAULT_TIMEOUT_SECONDS, detectProjectName, _planDeps } from "../../../src/cli/plan-runtime";
import type { PlanDeps, PlanModeContext, PlanCommandOptions } from "../../../src/plan/strategies";
import { buildPlanModeContext, assertIsValidPrd, createPlanStrategy } from "../../../src/plan/strategies";
import { SinglePlanStrategy, _singlePlanDeps } from "../../../src/plan/strategies/single";
import { PipelinePlanStrategy, _pipelinePlanDeps } from "../../../src/plan/strategies/pipeline";
import { DebatePlanStrategy, _debatePlanDeps } from "../../../src/plan/strategies/debate";
import { buildPlanComposition } from "../../../src/plan/strategies/debate-composition";
import type { InteractionBridge } from "../../../src/interaction/bridge-builder";
import type { DebateStageConfig } from "../../../src/debate/types";
import { validateFeatureName } from "../../../src/utils/feature-name";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRuntime(closeImpl?: () => Promise<void>): NaxRuntime {
  return {
    packages: { resolve: () => ({}) },
    agentManager: { getDefault: () => "claude" },
    sessionManager: {} as any,
    runId: "test-run-id",
    close: closeImpl ?? (async () => {}),
  } as unknown as NaxRuntime;
}

function makeDeps(overrides?: Partial<PlanDeps>): PlanDeps {
  return {
    readFile: async (path: string) => `content of ${path}`,
    writeFile: async () => {},
    mkdirp: async () => {},
    existsSync: () => false,
    readPackageJson: async () => null,
    readPackageJsonAt: async () => null,
    scanSourceRoots: async () => [],
    spawnSync: () => ({ stdout: Buffer.from(""), exitCode: 0 }),
    initInteractionChain: async () => null,
    createInteractionBridge: () => ({
      detectQuestion: async () => false,
      onQuestionDetected: async () => "",
    } as InteractionBridge),
    createDebateRunner: () => ({}) as any,
    getLogger: () => undefined,
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<PlanModeContext>): PlanModeContext {
  return {
    workdir: "/tmp/test-project",
    naxDir: "/tmp/test-project/.nax",
    outputDir: "/tmp/test-project/.nax/features/test-feature",
    outputPath: "/tmp/test-project/.nax/features/test-feature/prd.json",
    specContent: "# Test Spec",
    codebaseContext: "# Codebase",
    normalizedRoots: [],
    relativePackages: [],
    packageDetails: [],
    projectName: "test-project",
    branchName: "feat/test-feature",
    timeoutSeconds: 600,
    config: planConfigSelector.select(DEFAULT_CONFIG),
    fullConfig: DEFAULT_CONFIG,
    options: { from: "/tmp/spec.md", feature: "test-feature" } as PlanCommandOptions,
    runtime: makeRuntime(),
    interactionChain: null,
    interactionBridge: {} as InteractionBridge,
    deps: makeDeps(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1: detectProjectName exports from plan-runtime.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: detectProjectName exported and returns package name", () => {
  test("should return pkg.name when it is a non-empty string", () => {
    const workdir = "/test";
    const pkg = { name: "my-project", version: "1.0.0" };
    const result = detectProjectName(workdir, pkg);
    expect(result).toBe("my-project");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2: detectProjectName extracts from git remote URL
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2: detectProjectName extracts basename from git remote URL", () => {
  test("should extract repo name from git URL when pkg.name is absent", () => {
    const origSpawn = _planDeps.spawnSync;
    _planDeps.spawnSync = () => ({
      stdout: Buffer.from("https://github.com/acme/my-repo.git"),
      exitCode: 0,
    });
    try {
      const result = detectProjectName("/test", null);
      expect(result).toBe("my-repo");
    } finally {
      _planDeps.spawnSync = origSpawn;
    }
  });

  test("should strip .git suffix when extracting from URL", () => {
    const origSpawn = _planDeps.spawnSync;
    _planDeps.spawnSync = () => ({
      stdout: Buffer.from("git@github.com:org/repo.git\n"),
      exitCode: 0,
    });
    try {
      const result = detectProjectName("/test", { name: "" });
      expect(result).toBe("repo");
    } finally {
      _planDeps.spawnSync = origSpawn;
    }
  });

  test("should return basename without .git from HTTP URL", () => {
    const origSpawn = _planDeps.spawnSync;
    _planDeps.spawnSync = () => ({
      stdout: Buffer.from("https://github.com/user/project-name"),
      exitCode: 0,
    });
    try {
      const result = detectProjectName("/test", { name: "" });
      expect(result).toBe("project-name");
    } finally {
      _planDeps.spawnSync = origSpawn;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: detectProjectName returns "unknown" fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-3: detectProjectName returns 'unknown' when name absent and git unavailable", () => {
  test("should return 'unknown' when pkg has no name and git command fails", () => {
    const origSpawn = _planDeps.spawnSync;
    _planDeps.spawnSync = () => ({
      stdout: Buffer.from(""),
      exitCode: 128, // git error
    });
    try {
      const result = detectProjectName("/test", null);
      expect(result).toBe("unknown");
    } finally {
      _planDeps.spawnSync = origSpawn;
    }
  });

  test("should return 'unknown' when git returns unparseable output", () => {
    const origSpawn = _planDeps.spawnSync;
    _planDeps.spawnSync = () => ({
      stdout: Buffer.from("not-a-url"),
      exitCode: 0,
    });
    try {
      const result = detectProjectName("/test", { name: "" });
      expect(result).toBe("unknown");
    } finally {
      _planDeps.spawnSync = origSpawn;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: plan.ts imports detectProjectName from plan-runtime
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-4: src/cli/plan.ts imports detectProjectName from plan-runtime", () => {
  test("should import detectProjectName from plan-runtime", async () => {
    const planModule = await import("../../../src/cli/plan.ts");
    const planCommandModule = await import("../../../src/cli/plan-command.ts");
    // Verify that plan-command.ts (which is re-exported by plan.ts) imports from plan-runtime
    const source = await Bun.file("../../../src/cli/plan-command.ts").text();
    expect(source).toContain("import { DEFAULT_TIMEOUT_SECONDS, _planDeps, createPlanRuntime, detectProjectName } from");
    expect(source).toContain("./plan-runtime");
  });

  test("should not define detectProjectName locally in plan.ts", async () => {
    const planSource = await Bun.file("../../../src/cli/plan.ts").text();
    // plan.ts should only export things, not define detectProjectName
    expect(planSource).not.toContain("function detectProjectName");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: buildPlanModeContext - branchName property
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: buildPlanModeContext returns correct branchName", () => {
  test("should return options.branch when provided as non-empty string", async () => {
    const config = DEFAULT_CONFIG;
    const options: PlanCommandOptions = {
      from: "/tmp/spec.md",
      feature: "my-feature",
      branch: "custom-branch-name",
    };
    const deps = makeDeps({
      readFile: async () => "spec",
      scanSourceRoots: async () => [],
      readPackageJson: async () => null,
      mkdirp: async () => {},
      existsSync: () => true,
    });

    const ctx = await buildPlanModeContext("/tmp/test", config, options, deps);
    expect(ctx.branchName).toBe("custom-branch-name");
  });

  test("should concatenate 'feat/' + feature when branch not provided", async () => {
    const config = DEFAULT_CONFIG;
    const options: PlanCommandOptions = {
      from: "/tmp/spec.md",
      feature: "new-auth",
    };
    const deps = makeDeps({
      readFile: async () => "spec",
      scanSourceRoots: async () => [],
      readPackageJson: async () => null,
      mkdirp: async () => {},
      existsSync: () => true,
    });

    const ctx = await buildPlanModeContext("/tmp/test", config, options, deps);
    expect(ctx.branchName).toBe("feat/new-auth");
  });

  test("should use feat/ + feature when branch is empty string", async () => {
    const config = DEFAULT_CONFIG;
    const options: PlanCommandOptions = {
      from: "/tmp/spec.md",
      feature: "auth-flow",
      branch: "",
    };
    const deps = makeDeps({
      readFile: async () => "spec",
      scanSourceRoots: async () => [],
      readPackageJson: async () => null,
      mkdirp: async () => {},
      existsSync: () => true,
    });

    const ctx = await buildPlanModeContext("/tmp/test", config, options, deps);
    expect(ctx.branchName).toBe("feat/auth-flow");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-6: buildPlanModeContext - timeoutSeconds property
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-6: buildPlanModeContext returns correct timeoutSeconds", () => {
  test("should return config.plan.timeoutSeconds when defined and positive", async () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      plan: { ...DEFAULT_CONFIG.plan, timeoutSeconds: 1200 },
    };
    const options: PlanCommandOptions = {
      from: "/tmp/spec.md",
      feature: "test",
    };
    const deps = makeDeps({
      readFile: async () => "spec",
      scanSourceRoots: async () => [],
      readPackageJson: async () => null,
      mkdirp: async () => {},
      existsSync: () => true,
    });

    const ctx = await buildPlanModeContext("/tmp/test", config, options, deps);
    expect(ctx.timeoutSeconds).toBe(1200);
  });

  test("should return DEFAULT_TIMEOUT_SECONDS when config.plan.timeoutSeconds undefined", async () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      plan: { ...DEFAULT_CONFIG.plan, timeoutSeconds: undefined },
    };
    const options: PlanCommandOptions = {
      from: "/tmp/spec.md",
      feature: "test",
    };
    const deps = makeDeps({
      readFile: async () => "spec",
      scanSourceRoots: async () => [],
      readPackageJson: async () => null,
      mkdirp: async () => {},
      existsSync: () => true,
    });

    const ctx = await buildPlanModeContext("/tmp/test", config, options, deps);
    expect(ctx.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
  });

  test("should return DEFAULT_TIMEOUT_SECONDS when plan config is null", async () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      plan: null as any,
    };
    const options: PlanCommandOptions = {
      from: "/tmp/spec.md",
      feature: "test",
    };
    const deps = makeDeps({
      readFile: async () => "spec",
      scanSourceRoots: async () => [],
      readPackageJson: async () => null,
      mkdirp: async () => {},
      existsSync: () => true,
    });

    const ctx = await buildPlanModeContext("/tmp/test", config, options, deps);
    expect(ctx.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7: SinglePlanStrategy.execute rethrows callOp error when output doesn't exist
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7: SinglePlanStrategy.execute rethrows error when outputPath doesn't exist", () => {
  test("should rethrow callOp error when ctx.outputPath does not exist on disk", async () => {
    const strategy = new SinglePlanStrategy();
    const ctx = makeCtx({
      deps: makeDeps({ existsSync: () => false }),
    });

    const testError = new Error("callOp failed");
    let callOpMock: typeof _singlePlanDeps.callOp;

    const origCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = async () => {
      throw testError;
    };

    try {
      await expect(strategy.execute(ctx)).rejects.toEqual(testError);
    } finally {
      _singlePlanDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8: SinglePlanStrategy calls assertIsValidPrd before writeFile
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8: SinglePlanStrategy.execute calls assertIsValidPrd before writeFile", () => {
  test("should call assertIsValidPrd with PRD before calling writeFile", async () => {
    const strategy = new SinglePlanStrategy();
    const callOrder: string[] = [];

    const ctx = makeCtx({
      deps: makeDeps({
        writeFile: async () => {
          callOrder.push("writeFile");
        },
        existsSync: () => false,
      }),
    });

    const mockValidPrd = { userStories: [{ id: "US-001", title: "Test" }] };

    const origCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = async () => {
      callOrder.push("callOp");
      return mockValidPrd;
    };

    try {
      await strategy.execute(ctx);
      expect(callOrder[0]).toBe("callOp");
      expect(callOrder[1]).toBe("writeFile");
    } finally {
      _singlePlanDeps.callOp = origCallOp;
    }
  });

  test("assertIsValidPrd should throw when prd has no userStories", () => {
    expect(() => {
      assertIsValidPrd({ userStories: [] });
    }).toThrow();
  });

  test("assertIsValidPrd should throw when prd is not an object", () => {
    expect(() => {
      assertIsValidPrd("not an object");
    }).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-9: SinglePlanStrategy writes correct JSON with project field
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-9: SinglePlanStrategy.execute writes JSON with project field", () => {
  test("should call writeFile with correctly formatted JSON including project", async () => {
    const strategy = new SinglePlanStrategy();
    let writtenPath: string | undefined;
    let writtenContent: string | undefined;

    const ctx = makeCtx({
      projectName: "test-project",
      outputPath: "/tmp/test-project/.nax/features/test-feature/prd.json",
      deps: makeDeps({
        writeFile: async (path: string, content: string) => {
          writtenPath = path;
          writtenContent = content;
        },
        existsSync: () => false,
      }),
    });

    const mockPrd = {
      userStories: [{ id: "US-001", title: "Test Story" }],
      feature: "test-feature",
    };

    const origCallOp = _singlePlanDeps.callOp;
    _singlePlanDeps.callOp = async () => mockPrd;

    try {
      await strategy.execute(ctx);
      expect(writtenPath).toBe(ctx.outputPath);
      expect(writtenContent).toBeDefined();

      const parsed = JSON.parse(writtenContent!);
      expect(parsed.project).toBe("test-project");
      expect(parsed.userStories).toEqual(mockPrd.userStories);
      expect(parsed.feature).toBe("test-feature");
    } finally {
      _singlePlanDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-10: PipelinePlanStrategy wraps ground operation errors correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-10: PipelinePlanStrategy.execute wraps ground operation errors with NaxError", () => {
  test("should catch ground operation error and throw NaxError with PLAN_PIPELINE_GROUND_FAILED", async () => {
    const strategy = new PipelinePlanStrategy();
    const originalError = new Error("ground operation failed");

    const ctx = makeCtx({
      fullConfig: {
        ...DEFAULT_CONFIG,
        plan: { citationThreshold: 0.5 },
      } as NaxConfig,
    });

    const origCallOp = _pipelinePlanDeps.callOp;
    _pipelinePlanDeps.callOp = async (callCtx, operation, input) => {
      if (operation.type === "run" && operation.operationId.includes("ground")) {
        throw originalError;
      }
      return {};
    };

    try {
      await expect(strategy.execute(ctx)).rejects.toThrow(NaxError);
    } catch (err) {
      if (err instanceof NaxError) {
        expect(err.code).toBe("PLAN_PIPELINE_GROUND_FAILED");
        expect(err.message).toContain("ground");
        expect(err.context?.cause).toBe(originalError);
      }
    } finally {
      _pipelinePlanDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: PipelinePlanStrategy writes PRD when critic verdict passes
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-11: PipelinePlanStrategy.execute writes PRD when verdict.outcome === 'passed'", () => {
  test("should write PRD exactly once when critic verdict passes", async () => {
    const strategy = new PipelinePlanStrategy();
    let writeCount = 0;
    let writtenContent: string | undefined;

    const ctx = makeCtx({
      projectName: "pipeline-project",
      outputPath: "/tmp/prd.json",
      fullConfig: {
        ...DEFAULT_CONFIG,
        plan: { citationThreshold: 0.5 },
      } as NaxConfig,
      deps: makeDeps({
        writeFile: async (path: string, content: string) => {
          writeCount++;
          writtenContent = content;
        },
      }),
    });

    const mockVerdict = {
      outcome: "passed",
      prd: { userStories: [{ id: "US-001" }], feature: "test" },
      specDeltasPath: undefined,
    };

    const origCallOp = _pipelinePlanDeps.callOp;
    const origRunPlanCritic = _pipelinePlanDeps.runPlanCritic;

    _pipelinePlanDeps.callOp = async () => ({});
    _pipelinePlanDeps.runPlanCritic = async () => mockVerdict as any;

    try {
      await strategy.execute(ctx);
      expect(writeCount).toBe(1);
      const parsed = JSON.parse(writtenContent!);
      expect(parsed.project).toBe("pipeline-project");
    } finally {
      _pipelinePlanDeps.callOp = origCallOp;
      _pipelinePlanDeps.runPlanCritic = origRunPlanCritic;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-12: PipelinePlanStrategy returns outputPath on success
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-12: PipelinePlanStrategy.execute returns outputPath when verdict passes and write succeeds", () => {
  test("should return outputPath when verdict passes and writeFile succeeds", async () => {
    const strategy = new PipelinePlanStrategy();
    const outputPath = "/tmp/project/.nax/features/feat/prd.json";

    const ctx = makeCtx({
      outputPath,
      projectName: "test-proj",
      fullConfig: {
        ...DEFAULT_CONFIG,
        plan: { citationThreshold: 0.5 },
      } as NaxConfig,
      deps: makeDeps({
        writeFile: async () => {},
      }),
    });

    const mockVerdict = {
      outcome: "passed",
      prd: { userStories: [{ id: "US-001" }] },
    };

    const origCallOp = _pipelinePlanDeps.callOp;
    const origRunPlanCritic = _pipelinePlanDeps.runPlanCritic;

    _pipelinePlanDeps.callOp = async () => ({});
    _pipelinePlanDeps.runPlanCritic = async () => mockVerdict as any;

    try {
      const result = await strategy.execute(ctx);
      expect(result).toBe(outputPath);
    } finally {
      _pipelinePlanDeps.callOp = origCallOp;
      _pipelinePlanDeps.runPlanCritic = origRunPlanCritic;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-13: PipelinePlanStrategy passes citationThreshold in planDraftOp input
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-13: PipelinePlanStrategy passes citationThreshold from config in planDraftOp", () => {
  test("should pass citationThreshold from config.plan to planDraftOp input", async () => {
    const strategy = new PipelinePlanStrategy();
    let capturedInput: any;

    const ctx = makeCtx({
      fullConfig: {
        ...DEFAULT_CONFIG,
        plan: { citationThreshold: 0.7 },
      } as NaxConfig,
      deps: makeDeps({
        writeFile: async () => {},
      }),
    });

    const origCallOp = _pipelinePlanDeps.callOp;
    _pipelinePlanDeps.callOp = async (callCtx, operation, input) => {
      if (operation.type === "run" && operation.operationId.includes("draft")) {
        capturedInput = input;
      }
      return { prd: { userStories: [] } };
    };

    const origRunPlanCritic = _pipelinePlanDeps.runPlanCritic;
    _pipelinePlanDeps.runPlanCritic = async () => ({
      outcome: "passed",
      prd: { userStories: [] },
    } as any);

    try {
      await strategy.execute(ctx);
      expect(capturedInput?.citationThreshold).toBe(0.7);
    } finally {
      _pipelinePlanDeps.callOp = origCallOp;
      _pipelinePlanDeps.runPlanCritic = origRunPlanCritic;
    }
  });

  test("should use default 0.5 when config.plan.citationThreshold is undefined", async () => {
    const strategy = new PipelinePlanStrategy();
    let capturedInput: any;

    const ctx = makeCtx({
      fullConfig: {
        ...DEFAULT_CONFIG,
        plan: { citationThreshold: undefined },
      } as NaxConfig,
      deps: makeDeps({
        writeFile: async () => {},
      }),
    });

    const origCallOp = _pipelinePlanDeps.callOp;
    _pipelinePlanDeps.callOp = async (callCtx, operation, input) => {
      if (operation.type === "run" && operation.operationId.includes("draft")) {
        capturedInput = input;
      }
      return { prd: { userStories: [] } };
    };

    const origRunPlanCritic = _pipelinePlanDeps.runPlanCritic;
    _pipelinePlanDeps.runPlanCritic = async () => ({
      outcome: "passed",
      prd: { userStories: [] },
    } as any);

    try {
      await strategy.execute(ctx);
      expect(capturedInput?.citationThreshold).toBe(0.5);
    } finally {
      _pipelinePlanDeps.callOp = origCallOp;
      _pipelinePlanDeps.runPlanCritic = origRunPlanCritic;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-14: DebatePlanStrategy writes PRD and doesn't call callOp when debate succeeds
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-14: DebatePlanStrategy.execute writes PRD without callOp when debate succeeds", () => {
  test("should write PRD and NOT invoke callOp when debate outcome !== 'failed' and output exists", async () => {
    const strategy = new DebatePlanStrategy();
    let callOpInvoked = false;
    let writeFileInvoked = false;

    const ctx = makeCtx({
      projectName: "debate-project",
      outputPath: "/tmp/prd.json",
      fullConfig: {
        ...DEFAULT_CONFIG,
        debate: { enabled: true } as any,
      } as NaxConfig,
      deps: makeDeps({
        writeFile: async () => {
          writeFileInvoked = true;
        },
        createDebateRunner: () => ({
          runPlan: async () => ({
            outcome: "passed",
            output: '{"userStories": [{"id": "US-001"}]}',
          }),
        } as any),
      }),
    });

    const origCallOp = _debatePlanDeps.callOp;
    _debatePlanDeps.callOp = async () => {
      callOpInvoked = true;
      return {};
    };

    try {
      await strategy.execute(ctx);
      expect(writeFileInvoked).toBe(true);
      expect(callOpInvoked).toBe(false);
    } finally {
      _debatePlanDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-15: DebatePlanStrategy passes maxInteractionTurns conditionally
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-15: DebatePlanStrategy passes maxInteractionTurns to runner.runPlan conditionally", () => {
  test("should pass maxInteractionTurns in opts when config.agent.maxInteractionTurns is defined", async () => {
    const strategy = new DebatePlanStrategy();
    let capturedOpts: any;

    const ctx = makeCtx({
      fullConfig: {
        ...DEFAULT_CONFIG,
        debate: { enabled: true } as any,
        agent: { maxInteractionTurns: 5 },
      } as NaxConfig,
      deps: makeDeps({
        writeFile: async () => {},
        createDebateRunner: () => ({
          runPlan: async (taskCtx: any, outputFormat: any, opts: any) => {
            capturedOpts = opts;
            return { outcome: "failed", output: "" };
          },
        } as any),
      }),
    });

    const origCallOp = _debatePlanDeps.callOp;
    _debatePlanDeps.callOp = async () => ({
      userStories: [{ id: "US-001" }],
    });

    try {
      await strategy.execute(ctx);
      expect(capturedOpts.maxInteractionTurns).toBe(5);
    } finally {
      _debatePlanDeps.callOp = origCallOp;
    }
  });

  test("should NOT include maxInteractionTurns in opts when undefined", async () => {
    const strategy = new DebatePlanStrategy();
    let capturedOpts: any;

    const ctx = makeCtx({
      fullConfig: {
        ...DEFAULT_CONFIG,
        debate: { enabled: true } as any,
        agent: { maxInteractionTurns: undefined },
      } as NaxConfig,
      deps: makeDeps({
        writeFile: async () => {},
        createDebateRunner: () => ({
          runPlan: async (taskCtx: any, outputFormat: any, opts: any) => {
            capturedOpts = opts;
            return { outcome: "failed", output: "" };
          },
        } as any),
      }),
    });

    const origCallOp = _debatePlanDeps.callOp;
    _debatePlanDeps.callOp = async () => ({
      userStories: [{ id: "US-001" }],
    });

    try {
      await strategy.execute(ctx);
      expect("maxInteractionTurns" in capturedOpts).toBe(false);
    } finally {
      _debatePlanDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-16: buildPlanComposition returns input unchanged when evidenceMode !== "asymmetric"
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-16: buildPlanComposition returns unchanged input when evidenceMode !== 'asymmetric'", () => {
  test("should return input object unchanged when evidenceMode is 'current'", () => {
    const input: DebateStageConfig & { evidenceMode?: "current" | "asymmetric" } = {
      kind: "debate",
      evidenceMode: "current",
      proposers: { citationsRequired: false },
    } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };

    const result = buildPlanComposition(input);
    expect(result).toEqual(input);
  });

  test("should return input object unchanged when evidenceMode is undefined", () => {
    const input: DebateStageConfig & { evidenceMode?: "current" | "asymmetric" } = {
      kind: "debate",
      proposers: { citationsRequired: true },
    } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };

    const result = buildPlanComposition(input);
    expect(result).toEqual(input);
  });

  test("should not add any properties when evidenceMode !== 'asymmetric'", () => {
    const input: DebateStageConfig & { evidenceMode?: "current" | "asymmetric" } = {
      kind: "debate",
      evidenceMode: "current",
    } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };

    const result = buildPlanComposition(input);
    const inputKeys = Object.keys(input).sort();
    const resultKeys = Object.keys(result).sort();
    expect(inputKeys).toEqual(resultKeys);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-17: buildPlanComposition adds preDebatePhase when evidenceMode === "asymmetric"
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-17: buildPlanComposition adds preDebatePhase when evidenceMode === 'asymmetric'", () => {
  test("should add preDebatePhase with kind: 'grounder' when asymmetric and undefined", () => {
    const input: DebateStageConfig & { evidenceMode?: "current" | "asymmetric" } = {
      kind: "debate",
      evidenceMode: "asymmetric",
    } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };

    const result = buildPlanComposition(input);
    expect(result.preDebatePhase).toBeDefined();
    expect(result.preDebatePhase?.kind).toBe("grounder");
  });

  test("should NOT overwrite existing preDebatePhase when asymmetric", () => {
    const existing = { kind: "custom" as const };
    const input: DebateStageConfig & { evidenceMode?: "current" | "asymmetric" } = {
      kind: "debate",
      evidenceMode: "asymmetric",
      preDebatePhase: existing as any,
    } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };

    const result = buildPlanComposition(input);
    expect(result.preDebatePhase).toEqual(existing);
  });

  test("should spread all input properties and add asymmetric defaults", () => {
    const input: DebateStageConfig & { evidenceMode?: "current" | "asymmetric" } = {
      kind: "debate",
      evidenceMode: "asymmetric",
      proposers: { citationsRequired: false, fileReadAccess: false },
    } as DebateStageConfig & { evidenceMode?: "current" | "asymmetric" };

    const result = buildPlanComposition(input);
    expect(result.kind).toBe("debate");
    expect(result.proposers?.citationsRequired).toBe(true); // default overrides
    expect(result.preDebatePhase?.kind).toBe("grounder");
    expect(result.sessionMode).toBe("stateful");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-18: DebatePlanStrategy passes ctx.fullConfig to createDebateRunner
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-18: DebatePlanStrategy.execute passes ctx.fullConfig to createDebateRunner", () => {
  test("should pass ctx.fullConfig as the config parameter to createDebateRunner", async () => {
    const strategy = new DebatePlanStrategy();
    let capturedConfig: any;

    const testConfig: NaxConfig = {
      ...DEFAULT_CONFIG,
      debate: { enabled: true } as any,
    };

    const ctx = makeCtx({
      fullConfig: testConfig,
      deps: makeDeps({
        writeFile: async () => {},
        createDebateRunner: (opts: any) => {
          capturedConfig = opts.config;
          return {
            runPlan: async () => ({
              outcome: "failed",
              output: "",
            }),
          } as any;
        },
      }),
    });

    const origCallOp = _debatePlanDeps.callOp;
    _debatePlanDeps.callOp = async () => ({
      userStories: [{ id: "US-001" }],
    });

    try {
      await strategy.execute(ctx);
      expect(capturedConfig).toEqual(testConfig);
    } finally {
      _debatePlanDeps.callOp = origCallOp;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-19: assertIsValidPrd is importable from src/plan/index.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-19: assertIsValidPrd is importable from src/plan/index.ts", () => {
  test("should be importable from src/plan/index.ts", async () => {
    const planModule = await import("../../../src/plan/index.ts");
    expect(typeof planModule.assertIsValidPrd).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-20: Strategy classes exported from src/plan/index.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-20: All strategy symbols re-exported from src/plan/index.ts", () => {
  test("should export createPlanStrategy, SinglePlanStrategy, PipelinePlanStrategy, DebatePlanStrategy, IPlanStrategy", async () => {
    const planModule = await import("../../../src/plan/index.ts");
    expect(typeof planModule.createPlanStrategy).toBe("function");
    expect(typeof planModule.SinglePlanStrategy).toBe("function");
    expect(typeof planModule.PipelinePlanStrategy).toBe("function");
    expect(typeof planModule.DebatePlanStrategy).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-21: planCommand calls validateFeatureName before buildPlanModeContext
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-21: planCommand calls validateFeatureName before buildPlanModeContext", () => {
  test("should throw error from validateFeatureName when feature name is invalid", async () => {
    const { planCommand } = await import("../../../src/cli/plan-command.ts");
    const config = DEFAULT_CONFIG;
    const options = {
      from: "/tmp/spec.md",
      feature: "invalid/../feature",
    };

    await expect(planCommand("/tmp/test", config, options)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-22: planCommand throws NaxError when .nax directory doesn't exist
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-22: planCommand throws NaxError when .nax directory doesn't exist", () => {
  test("should throw error with stage='plan' before buildPlanModeContext when .nax missing", async () => {
    const config = DEFAULT_CONFIG;
    const options = {
      from: "/tmp/spec.md",
      feature: "test-feature",
    };

    const deps = makeDeps({
      readFile: async () => "spec content",
      existsSync: () => false, // .nax directory doesn't exist
      mkdirp: async () => {},
    });

    // buildPlanModeContext should throw when .nax dir doesn't exist
    await expect(buildPlanModeContext("/tmp/nonexistent", config, options, deps)).rejects.toThrow();
  });
});