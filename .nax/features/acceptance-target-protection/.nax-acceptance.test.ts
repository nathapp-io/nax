import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { makeNaxConfig, makeStory, withDepsRestore } from "../../../test/helpers";
import type { PipelineContext } from "../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { PRD, UserStory } from "../../../src/prd";

// ---------------------------------------------------------------------------
// US-001: `.nax/` immutability guard in code-touching role prompts
// ---------------------------------------------------------------------------

describe("US-001: .nax/ immutability guard", () => {
  test("AC-1: buildNaxArtifactsSection('test-writer') states .nax/ files must never be moved/renamed/deleted", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    const section = buildNaxArtifactsSection("test-writer");
    expect(section).toMatch(
      /\.nax\/.*(?:must never be moved|must never be renamed|must never be deleted|are immutable|do not move|do not rename|do not delete)/i,
    );
  });

  test("AC-2: buildNaxArtifactsSection('test-writer') returns a non-null string", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    const result = buildNaxArtifactsSection("test-writer");
    expect(typeof result === "string" && result !== null).toBe(true);
  });

  test("AC-3: buildNaxArtifactsSection('implementer') returns a non-null string", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    const result = buildNaxArtifactsSection("implementer");
    expect(typeof result === "string" && result !== null).toBe(true);
  });

  test("AC-4: buildNaxArtifactsSection('verifier') returns a non-null string (unlike guardrails, which returns null for verifier)", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    const result = buildNaxArtifactsSection("verifier");
    expect(typeof result === "string" && result !== null).toBe(true);
  });

  /** Returns true if `negationRegex` matches within 50 chars of a `.nax/` occurrence. */
  function hasProximateMatch(text: string, negationRegex: RegExp): boolean {
    const naxPositions: number[] = [];
    const naxRe = /\.nax\//g;
    let m: RegExpExecArray | null;
    while ((m = naxRe.exec(text)) !== null) naxPositions.push(m.index);

    const negRe = new RegExp(negationRegex.source, `${negationRegex.flags.replace("g", "")}g`);
    let n: RegExpExecArray | null;
    while ((n = negRe.exec(text)) !== null) {
      const negStart = n.index;
      const negEnd = n.index + n[0].length;
      for (const naxIdx of naxPositions) {
        const naxEnd = naxIdx + ".nax/".length;
        // "within 50 chars before or after" — windows must be within 50 chars of each other
        if (negStart <= naxEnd + 50 && naxIdx <= negEnd + 50) return true;
      }
    }
    return false;
  }

  test("AC-5: section states a .nax/ test is not a reason to skip writing source-tree tests", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    for (const role of ["test-writer", "implementer", "verifier"] as const) {
      const section = buildNaxArtifactsSection(role);
      expect(section).toContain(".nax/");
      expect(hasProximateMatch(section, /skip|ignore|omit.*source.*tree|skip.*writing/i)).toBe(true);
    }
  });

  test("AC-6: section states a source-tree test is not a reason to remove the .nax/ artifact", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    for (const role of ["test-writer", "implementer", "verifier"] as const) {
      const section = buildNaxArtifactsSection(role);
      expect(section).toMatch(/source(?:-|\s)?tree|source/i);
      expect(hasProximateMatch(section, /remove|delete|drop|eliminate/i)).toBe(true);
    }
  });

  test("AC-7: a TddPromptBuilder test-writer prompt includes the .nax/ immutability text verbatim", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    const { TddPromptBuilder } = await import("../../../src/prompts/builders/tdd-builder");

    const section = buildNaxArtifactsSection("test-writer");
    const config = makeNaxConfig();
    const story = makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: does a thing"] });

    const prompt = await TddPromptBuilder.buildForRole("test-writer", "/tmp/nax-test-workdir", config, story, {});
    expect(prompt).toContain(section);
  });

  test("AC-8: a TddPromptBuilder verifier prompt includes the .nax/ immutability text verbatim", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    const { TddPromptBuilder } = await import("../../../src/prompts/builders/tdd-builder");

    const section = buildNaxArtifactsSection("verifier");
    const config = makeNaxConfig();
    const story = makeStory({ id: "US-001", acceptanceCriteria: ["AC-1: does a thing"] });

    const prompt = await TddPromptBuilder.buildForRole("verifier", "/tmp/nax-test-workdir", config, story, {});
    expect(prompt).toContain(section);
  });

  test("AC-9: buildEscapeHatch output includes the rectifier .nax/ immutability text verbatim", async () => {
    const { buildNaxArtifactsSection } = await import("../../../src/prompts/sections");
    const { buildEscapeHatch } = await import("../../../src/prompts/builders/rectifier-builder-helpers");

    const section = buildNaxArtifactsSection("rectifier" as Parameters<typeof buildNaxArtifactsSection>[0]);
    const hatch = buildEscapeHatch({ includeMockHandoff: false });
    expect(hatch).toContain(section);
  });
});

// ---------------------------------------------------------------------------
// US-002: auto-commit restores deleted `.nax/` artifacts before staging
// ---------------------------------------------------------------------------

describe("US-002: auto-commit restores deleted .nax/ artifacts", () => {
  test("AC-10: parsePorcelain returns a deleted .nax/ path as protected", async () => {
    const { parsePorcelain } = await import("../../../src/utils/git");
    expect(parsePorcelain("D apps/web/.nax/features/f/.nax-acceptance.test.tsx")).toEqual([
      "apps/web/.nax/features/f/.nax-acceptance.test.tsx",
    ]);
  });

  test("AC-11: parsePorcelain returns the OLD path for a rename moving a file out of .nax/", async () => {
    const { parsePorcelain } = await import("../../../src/utils/git");
    expect(parsePorcelain("R  .nax/old/file.ts -> new/file.ts")).toEqual([".nax/old/file.ts"]);
  });

  test("AC-12: parsePorcelain returns empty for a .nax/ file that was only modified", async () => {
    const { parsePorcelain } = await import("../../../src/utils/git");
    expect(parsePorcelain("M .nax/foo/bar.ts")).toEqual([]);
  });

  test("AC-13: parsePorcelain returns empty for a deleted path outside .nax/", async () => {
    const { parsePorcelain } = await import("../../../src/utils/git");
    expect(parsePorcelain("D src/legacy.ts")).toEqual([]);
  });

  test("AC-14: parsePorcelain unquotes a deleted .nax/ path containing a space", async () => {
    const { parsePorcelain } = await import("../../../src/utils/git");
    expect(parsePorcelain('D ".nax/path with space.txt"')).toEqual([".nax/path with space.txt"]);
  });

  test("AC-15: parsePorcelain skips an unparseable line and still returns protected paths from the rest", async () => {
    const { parsePorcelain } = await import("../../../src/utils/git");
    expect(parsePorcelain("INVALID_LINE\nD .nax/deleted.ts")).toEqual([".nax/deleted.ts"]);
  });
});

describe("US-002: autoCommitIfDirty restore integration", () => {
  type SpawnResult = {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    stdin: { write: () => number; end: () => void; flush: () => void };
    exited: Promise<number>;
    pid: number;
    kill: () => void;
  };

  function makeProc(stdout: string, exitCode = 0): SpawnResult {
    const bytes = new TextEncoder().encode(stdout);
    return {
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stdin: { write: () => 0, end: () => {}, flush: () => {} },
      exited: Promise.resolve(exitCode),
      pid: 1,
      kill: () => {},
    };
  }

  let calls: { cmd: string[]; cwd?: string }[] = [];

  async function run(statusOutput: string, storyId: string, checkoutExit = 0) {
    const { _gitDeps, autoCommitIfDirty } = await import("../../../src/utils/git");
    const gitRoot = "/repo-nax-acc-target";
    calls = [];
    _gitDeps.spawn = mock((cmd: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.includes("rev-parse")) return makeProc(gitRoot + "\n");
      if (cmd.includes("status")) return makeProc(statusOutput);
      if (cmd.includes("checkout")) return makeProc("", checkoutExit);
      return makeProc("");
    }) as unknown as typeof _gitDeps.spawn;
    await autoCommitIfDirty(gitRoot, "tdd", "implementer", storyId);
  }

  test("AC-16: a deleted .nax/ path triggers a git checkout restore before git add -A", async () => {
    await run("D .nax/deleted.ts\n", "US-016");
    const checkoutIdx = calls.findIndex((c) => c.cmd.includes("checkout") && c.cmd.some((a) => a.includes(".nax/deleted.ts")));
    const addIdx = calls.findIndex((c) => c.cmd.includes("add") && c.cmd.includes("-A"));
    expect(checkoutIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(checkoutIdx).toBeLessThan(addIdx);
  });

  test("AC-17: the restore is logged at error level with storyId as args[0]", async () => {
    const gitModule = await import("../../../src/utils/git");
    const errorMock = mock(() => {});
    gitModule._gitDeps.getSafeLogger = mock(() => ({
      error: errorMock,
      warn: mock(() => {}),
      info: mock(() => {}),
      debug: mock(() => {}),
    })) as unknown as typeof gitModule._gitDeps.getSafeLogger;

    await run("D .nax/deleted.ts\n", "US-017");

    expect(errorMock).toHaveBeenCalled();
    const call = errorMock.mock.calls[0];
    expect(call[0]).toBe("US-017");
  });

  test("AC-18: a deletion outside .nax/ triggers no checkout — add and commit still run", async () => {
    await run("D src/changed.ts\n", "US-018");
    expect(calls.some((c) => c.cmd.includes("checkout"))).toBe(false);
    expect(calls.some((c) => c.cmd.includes("add") && c.cmd.includes("-A"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(true);
  });

  test("AC-19: a failed checkout restore still allows add and commit to run", async () => {
    await run("D .nax/deleted.ts\n", "US-019", 1);
    expect(calls.some((c) => c.cmd.includes("checkout"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("add") && c.cmd.includes("-A"))).toBe(true);
    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US-003: a missing acceptance target fails the acceptance stage
// ---------------------------------------------------------------------------

describe("US-003: missing acceptance target fails the stage", () => {
  function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
    const stories = [makeStory({ id: "US-001", status: "passed", passes: true })];
    return {
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, testPath: "acceptance.test.ts" },
      } as any,
      rootConfig: DEFAULT_CONFIG,
      prd: {
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        userStories: stories,
      } as PRD,
      story: stories[0],
      stories,
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      workdir: "/tmp/nax-acc-target-workdir",
      featureDir: "/tmp/nax-acc-target-workdir/.nax/features/test-feature",
      hooks: {} as any,
      ...overrides,
    } as PipelineContext;
  }

  test("AC-20: fails with 'Acceptance test file not found' when storyCount=1, acceptanceEnabled=true, file missing", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");
    const ctx = makeCtx({
      acceptanceTestPaths: [
        {
          testPath: `/tmp/nax-acc-${randomUUID()}/pkg-a/.nax-acceptance.test.ts`,
          packageDir: "/tmp/nax-acc-target-workdir/pkg-a",
          storyCount: 1,
          acceptanceEnabled: true,
        } as any,
      ],
    });
    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("fail");
    expect((result as { reason?: string }).reason).toContain("Acceptance test file not found");
  });

  test("AC-21: the failure reason names every missing target's packageDir", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");
    const suffix = randomUUID();
    const ctx = makeCtx({
      acceptanceTestPaths: [
        {
          testPath: `/tmp/nax-acc-${suffix}/pkg-a/.nax-acceptance.test.ts`,
          packageDir: "/tmp/nax-acc-target-workdir/pkg-a",
          storyCount: 1,
          acceptanceEnabled: true,
        },
        {
          testPath: `/tmp/nax-acc-${suffix}/pkg-b/.nax-acceptance.test.ts`,
          packageDir: "/tmp/nax-acc-target-workdir/pkg-b",
          storyCount: 1,
          acceptanceEnabled: true,
        },
        {
          testPath: `/tmp/nax-acc-${suffix}/pkg-c/.nax-acceptance.test.ts`,
          packageDir: "/tmp/nax-acc-target-workdir/pkg-c",
          storyCount: 1,
          acceptanceEnabled: true,
        },
      ] as any,
    });
    const result = await acceptanceStage.execute(ctx);
    const reason = (result as { reason?: string }).reason ?? "";
    expect(reason).toContain("/tmp/nax-acc-target-workdir/pkg-a");
    expect(reason).toContain("/tmp/nax-acc-target-workdir/pkg-b");
    expect(reason).toContain("/tmp/nax-acc-target-workdir/pkg-c");
  });

  test("AC-22: continues when the only missing-target group has storyCount=0", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");
    const ctx = makeCtx({
      prd: { ...makeCtx().prd, userStories: [] } as any,
      acceptanceTestPaths: [
        {
          testPath: `/tmp/nax-acc-${randomUUID()}/root/.nax-acceptance.test.ts`,
          packageDir: "/tmp/nax-acc-target-workdir",
          storyCount: 0,
          acceptanceEnabled: true,
        } as any,
      ],
    });
    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("AC-23: continues when the only missing-target group has acceptanceEnabled=false", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");
    const ctx = makeCtx({
      acceptanceTestPaths: [
        {
          testPath: `/tmp/nax-acc-${randomUUID()}/pkg-a/.nax-acceptance.test.ts`,
          packageDir: "/tmp/nax-acc-target-workdir/pkg-a",
          storyCount: 1,
          acceptanceEnabled: false,
        } as any,
      ],
    });
    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("continue");
  });

  test("AC-24: derives storyCount from ctx.prd when omitted and still fails for a package with one story", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");
    const packageDir = "/tmp/nax-acc-target-workdir/pkg-solo";
    const story: UserStory = makeStory({ id: "US-002", status: "passed", passes: true, workdir: "pkg-solo" });
    const ctx = makeCtx({
      prd: {
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        userStories: [story],
      } as PRD,
      story,
      stories: [story],
      acceptanceTestPaths: [
        {
          testPath: `/tmp/nax-acc-${randomUUID()}/pkg-solo/.nax-acceptance.test.ts`,
          packageDir,
          acceptanceEnabled: true,
        } as any,
      ],
    });
    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("fail");
  });

  test("AC-25: treats acceptanceEnabled as true when omitted and still fails", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");
    const ctx = makeCtx({
      acceptanceTestPaths: [
        {
          testPath: `/tmp/nax-acc-${randomUUID()}/pkg-a/.nax-acceptance.test.ts`,
          packageDir: "/tmp/nax-acc-target-workdir/pkg-a",
          storyCount: 1,
        } as any,
      ],
    });
    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("fail");
  });

  test("AC-26: a missing-target failure contributes no entries to failedACs", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");
    const ctx = makeCtx({
      acceptanceTestPaths: [
        {
          testPath: `/tmp/nax-acc-${randomUUID()}/pkg-a/.nax-acceptance.test.ts`,
          packageDir: "/tmp/nax-acc-target-workdir/pkg-a",
          storyCount: 1,
          acceptanceEnabled: true,
        } as any,
      ],
    });
    const result = await acceptanceStage.execute(ctx);
    const failedACs = (result as { failedACs?: string[] }).failedACs;
    expect(failedACs === undefined || (Array.isArray(failedACs) && failedACs.length === 0)).toBe(true);
  });

  test("AC-27: acceptanceStage.enabled() returns false when config.acceptance.enabled is false", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");
    const ctx = makeCtx({
      config: { ...DEFAULT_CONFIG, acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false } } as any,
    });
    expect(acceptanceStage.enabled(ctx)).toBe(false);
  });

  test("AC-28: continues when every target is present, storyCount>=1, and acceptanceEnabled=true", async () => {
    const { acceptanceStage } = await import("../../../src/pipeline/stages/acceptance");

    const origSpawn = Bun.spawn;
    const origFile = Bun.file;
    (Bun as any).spawn = (_cmd: string[], _opts: any) => ({
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("1 pass\n"));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });
    (Bun as any).file = (_p: string) => ({
      exists: () => Promise.resolve(true),
      text: () => Promise.resolve(""),
    });

    try {
      const ctx = makeCtx({
        acceptanceTestPaths: [
          {
            testPath: "/tmp/nax-acc-target-workdir/pkg-a/.nax-acceptance.test.ts",
            packageDir: "/tmp/nax-acc-target-workdir/pkg-a",
            storyCount: 1,
            acceptanceEnabled: true,
          } as any,
        ],
      });
      const result = await acceptanceStage.execute(ctx);
      expect(result.action).toBe("continue");
    } finally {
      (Bun as any).spawn = origSpawn;
      (Bun as any).file = origFile;
    }
  });

  test("AC-29: acceptance-setup populates storyCount from the number of PRD stories grouped into that package", async () => {
    const { groupStoriesByPackage } = await import("../../../src/acceptance");
    const stories: UserStory[] = [
      makeStory({ id: "US-101", workdir: "pkg-m" }),
      makeStory({ id: "US-102", workdir: "pkg-m" }),
      makeStory({ id: "US-103", workdir: "pkg-m" }),
    ];
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      userStories: stories,
    };
    const groups = await groupStoriesByPackage(prd, "/tmp/nax-acc-target-workdir", "test-feature");
    const group = groups.find((g) => g.stories.length === 3);
    expect(group).toBeDefined();
    expect((group as { storyCount?: number }).storyCount ?? group?.stories.length).toBe(3);
  });

  test("AC-30: runner-completion resolves acceptanceEnabled from the package's own config, not the root config", async () => {
    const { _runnerCompletionDeps, runCompletionPhase } = await import("../../../src/execution/runner-completion");
    const origDeps = { ..._runnerCompletionDeps };

    const packageConfig = makeNaxConfig({ acceptance: { enabled: true, maxRetries: 3 } });
    let capturedPaths: any[] | undefined;

    _runnerCompletionDeps.loadConfigForWorkdir = mock(async () => packageConfig) as any;
    _runnerCompletionDeps.runAcceptanceLoop = mock(async (ctx: any) => {
      capturedPaths = ctx.acceptanceTestPaths;
      return {
        success: true,
        prd: ctx.prd,
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 1,
        prdDirty: false,
      };
    }) as any;
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
    })) as any;

    const workdir = `/tmp/nax-acc-target-runner-${randomUUID()}`;
    const rootConfig = makeNaxConfig({ acceptance: { enabled: false, maxRetries: 3 } });
    const story = makeStory({ id: "US-201", status: "passed", passes: true, workdir: "pkg-sub" });
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      userStories: [story],
    };

    const statusWriter = {
      setPrd: mock(() => {}),
      setCurrentStory: mock(() => {}),
      setRunStatus: mock(() => {}),
      setPostRunPhase: mock(() => {}),
      update: mock(async () => {}),
      writeFeatureStatus: mock(async () => {}),
      getPostRunStatus: mock(() => ({ acceptance: { status: "not-run" }, regression: { status: "not-run" } })),
    };

    try {
      await runCompletionPhase({
        config: { ...rootConfig, acceptance: { ...rootConfig.acceptance, enabled: true } } as any,
        hooks: { hooks: {}, _skipGlobal: false } as any,
        feature: "test-feature",
        workdir,
        statusFile: `${workdir}/status.json`,
        runId: "run-030",
        startedAt: new Date().toISOString(),
        startTime: Date.now(),
        formatterMode: "quiet",
        headless: false,
        prd,
        allStoryMetrics: [],
        totalCost: 0,
        storiesCompleted: 1,
        iterations: 1,
        statusWriter: statusWriter as any,
        pluginRegistry: { getAll: () => [], get: () => undefined } as any,
        prdPath: `${workdir}/prd.json`,
      } as any);

      expect(capturedPaths).toBeDefined();
      const entry = capturedPaths?.find((p) => p.packageDir?.includes("pkg-sub"));
      expect((entry as any)?.acceptanceEnabled).toBe(true);
    } finally {
      Object.assign(_runnerCompletionDeps, origDeps);
    }
  });
});

// ---------------------------------------------------------------------------
// US-004: skipped packages reach status.json
// ---------------------------------------------------------------------------

describe("US-004: skipped packages reach status.json", () => {
  test("AC-31: AcceptanceLoopResult carries skippedPackages as the missing package names on a missing-target failure", async () => {
    const { runAcceptanceLoop } = await import("../../../src/execution/lifecycle/acceptance-loop");
    const acceptanceModule = await import("../../../src/pipeline/stages/acceptance");

    const origExecute = acceptanceModule.acceptanceStage.execute;
    (acceptanceModule.acceptanceStage as any).execute = mock(async () => ({
      action: "fail",
      reason: "Acceptance test file not found for package(s): pkg-a",
      skippedPackages: ["pkg-a"],
    }));

    try {
      const story = makeStory({ id: "US-301", status: "passed", passes: true });
      const prd: PRD = {
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        userStories: [story],
      };
      const result = await runAcceptanceLoop({
        config: makeNaxConfig(),
        prd,
        prdPath: "/tmp/prd.json",
        workdir: "/tmp/nax-acc-target-loop",
        hooks: { hooks: {}, _skipGlobal: false } as any,
        feature: "test-feature",
        totalCost: 0,
        iterations: 0,
        storiesCompleted: 1,
        allStoryMetrics: [],
        pluginRegistry: { getAll: () => [], get: () => undefined } as any,
        statusWriter: { setPostRunPhase: () => {} } as any,
      } as any);

      expect(Array.isArray(result.skippedPackages)).toBe(true);
      expect(result.skippedPackages).toEqual(["pkg-a"]);
    } finally {
      (acceptanceModule.acceptanceStage as any).execute = origExecute;
    }
  });

  async function runCompletionWithMissingPackage(runId: string) {
    const { _runnerCompletionDeps, runCompletionPhase } = await import("../../../src/execution/runner-completion");
    const origDeps = { ..._runnerCompletionDeps };

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (ctx: any) => ({
      success: false,
      prd: ctx.prd,
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
      failedACs: [],
      skippedPackages: ["pkg-a"],
    })) as any;
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
    })) as any;

    const setPostRunPhase = mock((_phase: string, _update: Record<string, unknown>) => {});
    const statusWriter = {
      setPrd: mock(() => {}),
      setCurrentStory: mock(() => {}),
      setRunStatus: mock(() => {}),
      setPostRunPhase,
      update: mock(async () => {}),
      writeFeatureStatus: mock(async () => {}),
      getPostRunStatus: mock(() => ({ acceptance: { status: "not-run" }, regression: { status: "not-run" } })),
    };

    const workdir = `/tmp/nax-acc-target-runner-${randomUUID()}`;
    const story = makeStory({ id: "US-401", status: "passed", passes: true });
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      userStories: [story],
    };

    try {
      await runCompletionPhase({
        config: makeNaxConfig({ acceptance: { enabled: true, maxRetries: 3 } }) as any,
        hooks: { hooks: {}, _skipGlobal: false } as any,
        feature: "test-feature",
        workdir,
        statusFile: `${workdir}/status.json`,
        runId,
        startedAt: new Date().toISOString(),
        startTime: Date.now(),
        formatterMode: "quiet",
        headless: false,
        prd,
        allStoryMetrics: [],
        totalCost: 0,
        storiesCompleted: 1,
        iterations: 1,
        statusWriter: statusWriter as any,
        pluginRegistry: { getAll: () => [], get: () => undefined } as any,
        prdPath: `${workdir}/prd.json`,
      } as any);

      return setPostRunPhase.mock.calls.filter((c: unknown[]) => c[0] === "acceptance");
    } finally {
      Object.assign(_runnerCompletionDeps, origDeps);
    }
  }

  test("AC-32: a missing-package acceptance failure sets phase=acceptance, status=failed, skippedPackages=['pkg-a']", async () => {
    const acceptanceCalls = await runCompletionWithMissingPackage("run-032");
    const failedCall = acceptanceCalls.find((c: unknown[]) => (c[1] as any)?.status === "failed");
    expect(failedCall).toBeDefined();
    expect((failedCall?.[1] as any)?.skippedPackages).toEqual(["pkg-a"]);
  });

  test("AC-33: a missing-target acceptance failure never sets phase=acceptance with status=passed", async () => {
    const acceptanceCalls = await runCompletionWithMissingPackage("run-033");
    const passedCall = acceptanceCalls.find((c: unknown[]) => (c[1] as any)?.status === "passed");
    expect(passedCall).toBeUndefined();
  });

  test("AC-34: when acceptance succeeds with every target present, status=passed and skippedPackages is empty/undefined", async () => {
    const { _runnerCompletionDeps, runCompletionPhase } = await import("../../../src/execution/runner-completion");
    const origDeps = { ..._runnerCompletionDeps };

    _runnerCompletionDeps.runAcceptanceLoop = mock(async (ctx: any) => ({
      success: true,
      prd: ctx.prd,
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
    })) as any;
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
    })) as any;

    const setPostRunPhase = mock((_phase: string, _update: Record<string, unknown>) => {});
    const statusWriter = {
      setPrd: mock(() => {}),
      setCurrentStory: mock(() => {}),
      setRunStatus: mock(() => {}),
      setPostRunPhase,
      update: mock(async () => {}),
      writeFeatureStatus: mock(async () => {}),
      getPostRunStatus: mock(() => ({ acceptance: { status: "not-run" }, regression: { status: "not-run" } })),
    };

    const workdir = `/tmp/nax-acc-target-runner-${randomUUID()}`;
    const story = makeStory({ id: "US-402", status: "passed", passes: true });
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      userStories: [story],
    };

    try {
      await runCompletionPhase({
        config: makeNaxConfig({ acceptance: { enabled: true, maxRetries: 3 } }) as any,
        hooks: { hooks: {}, _skipGlobal: false } as any,
        feature: "test-feature",
        workdir,
        statusFile: `${workdir}/status.json`,
        runId: "run-034",
        startedAt: new Date().toISOString(),
        startTime: Date.now(),
        formatterMode: "quiet",
        headless: false,
        prd,
        allStoryMetrics: [],
        totalCost: 0,
        storiesCompleted: 1,
        iterations: 1,
        statusWriter: statusWriter as any,
        pluginRegistry: { getAll: () => [], get: () => undefined } as any,
        prdPath: `${workdir}/prd.json`,
      } as any);

      const acceptanceCalls = setPostRunPhase.mock.calls.filter((c: unknown[]) => c[0] === "acceptance");
      const passedCall = acceptanceCalls.find((c: unknown[]) => (c[1] as any)?.status === "passed");
      expect(passedCall).toBeDefined();
      const skipped = (passedCall?.[1] as any)?.skippedPackages;
      expect(skipped === undefined || (Array.isArray(skipped) && skipped.length === 0)).toBe(true);
    } finally {
      Object.assign(_runnerCompletionDeps, origDeps);
    }
  });

  test("AC-35: a status.json with acceptance.status='failed' and skippedPackages=['pkg-a'] re-runs the acceptance loop with those skippedPackages", async () => {
    const { _runnerCompletionDeps, runCompletionPhase } = await import("../../../src/execution/runner-completion");
    const origDeps = { ..._runnerCompletionDeps };

    let loopWasCalled = false;
    let receivedSkippedPackages: unknown;
    _runnerCompletionDeps.runAcceptanceLoop = mock(async (ctx: any) => {
      loopWasCalled = true;
      receivedSkippedPackages = ctx.skippedPackages;
      return {
        success: true,
        prd: ctx.prd,
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 1,
        prdDirty: false,
      };
    }) as any;
    _runnerCompletionDeps.handleRunCompletion = mock(async () => ({
      durationMs: 1,
      runCompletedAt: new Date().toISOString(),
      finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
    })) as any;

    const statusWriter = {
      setPrd: mock(() => {}),
      setCurrentStory: mock(() => {}),
      setRunStatus: mock(() => {}),
      setPostRunPhase: mock(() => {}),
      update: mock(async () => {}),
      writeFeatureStatus: mock(async () => {}),
      getPostRunStatus: mock(() => ({
        acceptance: { status: "failed", skippedPackages: ["pkg-a"] },
        regression: { status: "not-run" },
      })),
    };

    const workdir = `/tmp/nax-acc-target-runner-${randomUUID()}`;
    const story = makeStory({ id: "US-403", status: "passed", passes: true });
    const prd: PRD = {
      project: "test-project",
      feature: "test-feature",
      branchName: "feat/test",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      userStories: [story],
    };

    try {
      await runCompletionPhase({
        config: makeNaxConfig({ acceptance: { enabled: true, maxRetries: 3 } }) as any,
        hooks: { hooks: {}, _skipGlobal: false } as any,
        feature: "test-feature",
        workdir,
        statusFile: `${workdir}/status.json`,
        runId: "run-035",
        startedAt: new Date().toISOString(),
        startTime: Date.now(),
        formatterMode: "quiet",
        headless: false,
        prd,
        allStoryMetrics: [],
        totalCost: 0,
        storiesCompleted: 1,
        iterations: 1,
        statusWriter: statusWriter as any,
        pluginRegistry: { getAll: () => [], get: () => undefined } as any,
        prdPath: `${workdir}/prd.json`,
      } as any);

      expect(loopWasCalled).toBe(true);
      expect(receivedSkippedPackages).toEqual(["pkg-a"]);
    } finally {
      Object.assign(_runnerCompletionDeps, origDeps);
    }
  });
});