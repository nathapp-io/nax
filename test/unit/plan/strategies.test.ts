import { afterEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { SourceRoot } from "@/analyze";
import { _planDeps, detectProjectName } from "@/cli";
import { DEFAULT_CONFIG, planConfigSelector } from "@/config";
import type { NaxConfig } from "@/config";
import { assertIsValidPrd, buildPlanModeContext, writeOrRecoverPrd } from "@/plan";
import type { IPlanStrategy, PlanDeps, PlanModeContext, PlanResult } from "@/plan/strategies";
import type { PRD } from "@/prd/types";
import { makeLogger, makeMockRuntime, makeNaxConfig } from "@test/helpers";

const SAMPLE_PRD: PRD = {
  project: "sample-project",
  feature: "feature-x",
  branchName: "feat/feature-x",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Story",
      description: "Story",
      acceptanceCriteria: ["AC-1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "Reason",
      },
    },
  ],
};

const SAMPLE_WORKDIR = "/tmp/nax-plan-strategy";
const SAMPLE_NAX_DIR = join(SAMPLE_WORKDIR, ".nax");
const SAMPLE_SPEC_PATH = join(SAMPLE_WORKDIR, "spec.md");
const SAMPLE_FEATURE = "feature-x";

const strategyContract: IPlanStrategy = {
  mode: "single",
  async execute(ctx: PlanModeContext): Promise<PlanResult> {
    return { outputPath: ctx.outputPath };
  },
};

void strategyContract;

function makeSourceRoots(workdir: string): SourceRoot[] {
  return [
    { path: ".", language: "typescript", framework: "", testRunner: "" },
    { path: `${workdir}/packages/api`, language: "typescript", framework: "Express", testRunner: "vitest" },
    { path: "apps/web", language: "typescript", framework: "Next.js", testRunner: "bun:test" },
  ];
}

function makeDeps(overrides: Partial<PlanDeps> = {}): PlanDeps {
  const interactionChain = {
    getPrimary() {
      return null;
    },
  };

  const deps: PlanDeps = {
    readFile: mock(async (path: string) => {
      if (path === SAMPLE_SPEC_PATH) return "# Spec\nDo the thing.";
      if (path === join(SAMPLE_NAX_DIR, "features", SAMPLE_FEATURE, "prd.json")) {
        return JSON.stringify(SAMPLE_PRD);
      }
      if (path.endsWith("package.json")) {
        return JSON.stringify({ name: "pkg-from-file" });
      }
      return "";
    }),
    writeFile: mock(async () => {}),
    mkdirp: mock(async () => {}),
    existsSync: mock(() => true),
    readPackageJson: mock(async () => ({ name: "pkg-from-json" })),
    readPackageJsonAt: mock(async (path: string) => {
      if (path.includes("packages/api")) {
        return { name: "@acme/api", scripts: { test: "bun test" }, dependencies: { express: "^4.0.0" } };
      }
      if (path.includes("apps/web")) {
        return { name: "@acme/web", scripts: { test: "vitest" }, devDependencies: { next: "^15.0.0" } };
      }
      return { name: path };
    }),
    scanSourceRoots: mock(async () => makeSourceRoots(SAMPLE_WORKDIR)),
    spawnSync: mock((_cmd: string[], _opts?: { cwd?: string }) => ({
      stdout: Buffer.from("git@github.com:acme/remote-repo.git"),
      exitCode: 0,
    })),
    initInteractionChain: mock(async () => interactionChain as never),
    createInteractionBridge: mock(() => ({
      detectQuestion: async () => false,
      onQuestionDetected: async () => "",
    })),
    createDebateRunner: mock(() => ({}) as never),
    getLogger: makeLogger,
    ...overrides,
  };

  return deps;
}

describe("detectProjectName", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns the package name when package.json has a name", () => {
    expect(detectProjectName(SAMPLE_WORKDIR, { name: "pkg-from-json" })).toBe("pkg-from-json");
  });

  test("falls back to the git remote repository name when package.json is anonymous", () => {
    const originalSpawnSync = _planDeps.spawnSync;
    _planDeps.spawnSync = mock(() => ({
      stdout: Buffer.from("git@github.com:acme/remote-repo.git"),
      exitCode: 0,
    }));

    try {
      expect(detectProjectName(SAMPLE_WORKDIR, null)).toBe("remote-repo");
    } finally {
      _planDeps.spawnSync = originalSpawnSync;
    }
  });
});

describe("buildPlanModeContext", () => {
  afterEach(() => {
    mock.restore();
  });

  test("assembles the shared context from the spec, workspace scan, and config slices", async () => {
    const fullConfig = makeNaxConfig({
      plan: { ...DEFAULT_CONFIG.plan, timeoutSeconds: 42, citationThreshold: 0.9 },
      debate: { ...DEFAULT_CONFIG.debate },
    });
    const deps = makeDeps();
    // Must have agentManager so createPlanRuntime's isRuntimeWithAgentManager check passes
    const expectedRuntime = makeMockRuntime();

    const origCreateRuntime = _planDeps.createRuntime;
    _planDeps.createRuntime = mock(() => expectedRuntime as never);

    try {
      const ctx = await buildPlanModeContext(
        SAMPLE_WORKDIR,
        fullConfig as NaxConfig,
        { from: SAMPLE_SPEC_PATH, feature: SAMPLE_FEATURE, branch: "feat/custom" },
        deps,
      );

      expect(ctx.specContent).toBe("# Spec\nDo the thing.");
      expect(ctx.relativePackages).toEqual(["packages/api", "apps/web"]);
      expect(ctx.relativePackages.every((pkg) => !pkg.startsWith("/"))).toBe(true);
      expect(ctx.packageDetails).toHaveLength(2);
      expect(ctx.packageDetails.map((pkg) => pkg.path)).toEqual(["packages/api", "apps/web"]);
      expect(ctx.projectName).toBe("pkg-from-json");
      expect(ctx.outputPath).toBe(join(SAMPLE_NAX_DIR, "features", SAMPLE_FEATURE, "prd.json"));
      expect(ctx.outputDir).toBe(join(SAMPLE_NAX_DIR, "features", SAMPLE_FEATURE));
      expect(deps.mkdirp).toHaveBeenCalledWith(ctx.outputDir);
      expect(ctx.config).toEqual(planConfigSelector.select(fullConfig));
      expect(ctx.config).not.toBe(fullConfig);
      expect(ctx.runtime).toBe(expectedRuntime);
      expect(_planDeps.createRuntime).toHaveBeenCalledWith(fullConfig, SAMPLE_WORKDIR, SAMPLE_FEATURE);
    } finally {
      _planDeps.createRuntime = origCreateRuntime;
    }
  });

  test("returns a null interaction chain when initInteractionChain resolves null", async () => {
    const fullConfig = makeNaxConfig();
    const deps = makeDeps({
      initInteractionChain: mock(async () => null),
    });

    const ctx = await buildPlanModeContext(
      SAMPLE_WORKDIR,
      fullConfig,
      { from: SAMPLE_SPEC_PATH, feature: SAMPLE_FEATURE },
      deps,
    );

    expect(ctx.interactionChain).toBeNull();
    expect(deps.initInteractionChain).toHaveBeenCalledWith(fullConfig, !process.stdin.isTTY);
  });
});

describe("writeOrRecoverPrd", () => {
  afterEach(() => {
    mock.restore();
  });

  test("writes the prd JSON to the output path and returns the path", async () => {
    const deps = makeDeps();
    const ctx = await buildPlanModeContext(
      SAMPLE_WORKDIR,
      makeNaxConfig(),
      { from: SAMPLE_SPEC_PATH, feature: SAMPLE_FEATURE },
      deps,
    );

    const result = await writeOrRecoverPrd(ctx, SAMPLE_PRD);

    expect(result.outputPath).toBe(ctx.outputPath);
    const writeCall = (deps.writeFile as ReturnType<typeof mock>).mock.calls.at(-1);
    expect(writeCall?.[0]).toBe(ctx.outputPath);
    const writtenPrd = JSON.parse(String(writeCall?.[1])) as PRD;
    expect(writtenPrd.project).toBe(ctx.projectName);
    expect(writtenPrd.feature).toBe(SAMPLE_PRD.feature);
    expect(writtenPrd.userStories).toHaveLength(SAMPLE_PRD.userStories.length);
    // finalizePrdRouting always stamps routingProfile (defaults to "default")
    expect(writtenPrd.routingProfile).toBe("default");
  });

  test("recovers by reading the written file when plan generation fails after write", async () => {
    const deps = makeDeps();
    const ctx = await buildPlanModeContext(
      SAMPLE_WORKDIR,
      makeNaxConfig(),
      { from: SAMPLE_SPEC_PATH, feature: SAMPLE_FEATURE },
      deps,
    );
    const err = new Error("plan failed");

    const result = await writeOrRecoverPrd(ctx, null, err);

    expect(result.outputPath).toBe(ctx.outputPath);
    expect(deps.readFile).toHaveBeenCalledWith(ctx.outputPath);
    const writeCall = (deps.writeFile as ReturnType<typeof mock>).mock.calls.at(-1);
    expect(writeCall?.[0]).toBe(ctx.outputPath);
    const writtenPrd = JSON.parse(String(writeCall?.[1])) as PRD;
    expect(writtenPrd.project).toBe(ctx.projectName);
    expect(writtenPrd.feature).toBe(SAMPLE_PRD.feature);
    expect(writtenPrd.userStories).toHaveLength(SAMPLE_PRD.userStories.length);
  });

  test("rethrows the original error when no recovered file exists", async () => {
    const deps = makeDeps({
      readFile: mock(async (path: string) => {
        if (path === SAMPLE_SPEC_PATH) return "# Spec";
        throw new Error("ENOENT");
      }),
    });
    const ctx = await buildPlanModeContext(
      SAMPLE_WORKDIR,
      makeNaxConfig(),
      { from: SAMPLE_SPEC_PATH, feature: SAMPLE_FEATURE },
      deps,
    );
    const err = new Error("plan failed");

    await expect(writeOrRecoverPrd(ctx, null, err)).rejects.toBe(err);
  });
});

describe("assertIsValidPrd", () => {
  test("throws for envelope-shaped objects that do not contain userStories", () => {
    expect(() => assertIsValidPrd({ project: "x" })).toThrow();
  });
});
