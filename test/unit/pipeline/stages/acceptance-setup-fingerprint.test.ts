import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeDispatchContext } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import {
  _acceptanceSetupDeps,
  acceptanceSetupStage,
  computeACFingerprint,
  computeAcceptanceLayoutFingerprint,
} from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, acceptanceCriteria: string[]) {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria,
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function makePrd(stories: ReturnType<typeof makeStory>[]) {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: stories,
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [
    makeStory("US-001", ["AC-1: first criterion", "AC-2: second criterion"]),
    makeStory("US-002", ["AC-1: third criterion"]),
  ];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: true,
        redGate: true,
        model: "fast",
      },
    },
    prd: makePrd(stories),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
    ...overrides,
  };
}

function makeDefaultCallOp(): typeof _acceptanceSetupDeps.callOp {
  return async (_ctx, _packageDir, op, input) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") {
      return { testCode: 'test("AC-1", () => { throw new Error("red") })' };
    }
    throw new Error(`unexpected op: ${op.name}`);
  };
}

let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// US-004: callOp is invoked during acceptance setup
// ---------------------------------------------------------------------------

describe("US-004: callOp is invoked during acceptance setup", () => {
  test("callOp is called during acceptance generation", async () => {
    let callOpCalled = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      callOpCalled = true;
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(callOpCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US-004: fingerprint reuse logging
// ---------------------------------------------------------------------------

describe("US-004: fingerprint reuse logging (staleness detection)", () => {
  function matchingFingerprint() {
    const criteria = ["AC-1: first criterion", "AC-2: second criterion", "AC-1: third criterion"];
    return computeACFingerprint(criteria);
  }

  function matchingLayoutFingerprint() {
    return computeAcceptanceLayoutFingerprint("/tmp/test-workdir", [
      {
        testPath: "/tmp/test-workdir/.nax/features/test-feature/.nax-acceptance.test.ts",
        stories: [{ id: "US-001" }, { id: "US-002" }],
      },
    ]);
  }

  test("does not regenerate when fingerprint matches — reuse path taken", async () => {
    let callOpCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: matchingFingerprint(),
      layoutFingerprint: matchingLayoutFingerprint(),
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.callOp = async () => {
      callOpCalled = true;
      return {};
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(callOpCalled).toBe(false);
  });

  test("regenerates and backs up when fingerprint mismatches", async () => {
    let copyFileCalled = false;
    let deleteFileCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: "sha256:outdated",
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {
      copyFileCalled = true;
    };
    _acceptanceSetupDeps.deleteFile = async () => {
      deleteFileCalled = true;
    };
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(copyFileCalled).toBe(true);
    expect(deleteFileCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US-001: Per-package acceptance test generation (ACC-002)
// ---------------------------------------------------------------------------

describe("US-001: per-package test file generation by workdir", () => {
  function makeStoryWithWorkdir(id: string, workdir: string, criteria: string[]) {
    return {
      id,
      title: `Story ${id}`,
      description: "desc",
      acceptanceCriteria: criteria,
      workdir,
      tags: [],
      dependencies: [],
      status: "pending" as const,
      passes: false,
      escalations: [],
      attempts: 0,
    };
  }

  test("AC-1: generates two test files for two-package monorepo", async () => {
    const writtenPaths: string[] = [];

    const stories = [
      makeStoryWithWorkdir("US-001", "apps/api", ["AC-1: api criterion"]),
      makeStoryWithWorkdir("US-002", "apps/cli", ["AC-1: cli criterion"]),
    ];
    const ctx = makeCtx({
      prd: {
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: stories,
      },
      story: stories[0],
      stories,
    });

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async (p) => {
      if (p.endsWith(".nax-acceptance.test.ts")) writtenPaths.push(p);
    };
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(ctx);

    expect(writtenPaths.length).toBe(2);
    expect(writtenPaths.some((p) => p.includes("apps/api") && p.includes(".nax-acceptance.test.ts"))).toBe(true);
    expect(writtenPaths.some((p) => p.includes("apps/cli") && p.includes(".nax-acceptance.test.ts"))).toBe(true);
  });

  test("AC-2: single-package project generates one file under .nax/features/<featureName>/", async () => {
    const writtenPaths: string[] = [];

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async (p) => {
      if (p.endsWith(".nax-acceptance.test.ts")) writtenPaths.push(p);
    };
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(writtenPaths.length).toBe(1);
    expect(writtenPaths[0]).toContain("/tmp/test-workdir/.nax/features/test-feature/.nax-acceptance.test.ts");
  });

  test("AC-4: RED gate runs each file from its package directory", async () => {
    const runTestCalls: Array<{ testPath: string; packageDir: string }> = [];

    const stories = [
      makeStoryWithWorkdir("US-001", "apps/api", ["AC-1: criterion"]),
      makeStoryWithWorkdir("US-002", "apps/cli", ["AC-1: criterion"]),
    ];
    const ctx = makeCtx({
      prd: {
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: stories,
      },
      story: stories[0],
      stories,
    });

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async (testPath, packageDir, _cmd) => {
      runTestCalls.push({ testPath, packageDir });
      return { exitCode: 1, output: "1 fail" };
    };

    await acceptanceSetupStage.execute(ctx);

    expect(runTestCalls.length).toBe(2);
    expect(runTestCalls.some((c) => c.packageDir.endsWith("apps/api"))).toBe(true);
    expect(runTestCalls.some((c) => c.packageDir.endsWith("apps/cli"))).toBe(true);
  });

  test("stores ctx.acceptanceTestPaths with testPath and packageDir for each group", async () => {
    const stories = [
      makeStoryWithWorkdir("US-001", "apps/api", ["AC-1: criterion"]),
      makeStoryWithWorkdir("US-002", "apps/cli", ["AC-1: criterion"]),
    ];
    const ctx = makeCtx({
      prd: {
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: stories,
      },
      story: stories[0],
      stories,
    });

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(ctx);

    expect(ctx.acceptanceTestPaths).toBeDefined();
    const acceptancePaths = ctx.acceptanceTestPaths;
    assertDefined(acceptancePaths, "ctx.acceptanceTestPaths");
    expect(acceptancePaths.length).toBe(2);
    expect(acceptancePaths.every((p) => p.testPath && p.packageDir)).toBe(true);
    expect(acceptancePaths.some((p) => p.packageDir.endsWith("apps/api"))).toBe(true);
    expect(acceptancePaths.some((p) => p.packageDir.endsWith("apps/cli"))).toBe(true);
  });

  test("US-003 AC-10: each ctx.acceptanceTestPaths entry's storyCount equals the number of PRD stories grouped into its package", async () => {
    const stories = [
      makeStoryWithWorkdir("US-001", "apps/api", ["AC-1: criterion"]),
      makeStoryWithWorkdir("US-002", "apps/api", ["AC-2: criterion"]),
      makeStoryWithWorkdir("US-003", "apps/cli", ["AC-1: criterion"]),
    ];
    const ctx = makeCtx({
      prd: {
        project: "test-project",
        feature: "test-feature",
        branchName: "feat/test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: stories,
      },
      story: stories[0],
      stories,
    });

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(ctx);

    expect(ctx.acceptanceTestPaths).toBeDefined();
    const groupedPaths = ctx.acceptanceTestPaths;
    assertDefined(groupedPaths, "ctx.acceptanceTestPaths");
    const apiEntry = groupedPaths.find((p) => p.packageDir.endsWith("apps/api"));
    const cliEntry = groupedPaths.find((p) => p.packageDir.endsWith("apps/cli"));
    expect(apiEntry?.storyCount).toBe(2);
    expect(cliEntry?.storyCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Absorbed: acceptance-setup-commit.test.ts
// ---------------------------------------------------------------------------

function commitMakeStory(id: string, acs: string[]) {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria: acs,
    tags: [],
    dependencies: [],
    status: "pending" as const,
    passes: false,
    escalations: [],
    attempts: 0,
  };
}

function commitMakeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  const stories = [commitMakeStory("US-001", ["AC-1: login", "AC-2: logout"])];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: false, redGate: false, model: "fast" },
    },
    prd: {
      project: "p",
      feature: "my-feature",
      branchName: "feat/x",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: stories,
    },
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/my-feature",
    hooks: { hooks: {} },
    ...makeDispatchContext(),
    ...overrides,
  };
}

/** Wire up the minimal happy-path deps for a generation run (no existing file/meta). */
function setupGenerationDeps(commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }>) {
  _acceptanceSetupDeps.fileExists = async () => false;
  _acceptanceSetupDeps.readMeta = async () => null;
  _acceptanceSetupDeps.copyFile = async () => {};
  _acceptanceSetupDeps.deleteFile = async () => {};
  _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
    if (op.name === "acceptance-generate") return { testCode: "// generated" };
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    throw new Error(`unexpected op: ${op.name}`);
  };
  _acceptanceSetupDeps.writeFile = async () => {};
  _acceptanceSetupDeps.writeMeta = async () => {};
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "RED" });
  _acceptanceSetupDeps.getAgent = mock(() => undefined);
  _acceptanceSetupDeps.autoCommitIfDirty = async (workdir, stage, role, storyId) => {
    commitCalls.push({ workdir, stage, role, storyId });
  };
}

/** Wire up deps simulating a fingerprint-match (no regeneration). */
function setupFingerprintMatchDeps(
  commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }>,
  fingerprint: string,
  layoutFingerprint: string,
) {
  _acceptanceSetupDeps.fileExists = async () => true;
  _acceptanceSetupDeps.readMeta = async () => ({
    generatedAt: new Date().toISOString(),
    acFingerprint: fingerprint,
    layoutFingerprint,
    storyCount: 1,
    acCount: 2,
    generator: "nax",
  });
  _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "RED" });
  _acceptanceSetupDeps.getAgent = mock(() => undefined);
  _acceptanceSetupDeps.autoCommitIfDirty = async (workdir, stage, role, storyId) => {
    commitCalls.push({ workdir, stage, role, storyId });
  };
}

// nax#1808: a dry run still reaches pre-run acceptance setup when acceptance is
// enabled, so guarding only the completion-phase commit left this path able to
// commit generated files during a run that was supposed to execute nothing.
describe("acceptance-setup: dry run", () => {
  test("forwards runtime.dryRun to autoCommitIfDirty", async () => {
    const dryRunArgs: Array<boolean | undefined> = [];
    setupGenerationDeps([]);
    _acceptanceSetupDeps.autoCommitIfDirty = async (
      _workdir: string,
      _stage: string,
      _role: string,
      _storyId: string,
      _blocked?: ReadonlySet<string>,
      dryRun?: boolean,
    ) => {
      dryRunArgs.push(dryRun);
    };
    const ctx = commitMakeCtx();
    (ctx.runtime as { dryRun: boolean }).dryRun = true;

    await acceptanceSetupStage.execute(ctx);

    expect(dryRunArgs).toEqual([true]);
  });
});

describe("acceptance-setup: autoCommitIfDirty after generation", () => {
  test("calls autoCommitIfDirty after generating acceptance test files", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = commitMakeCtx();

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls).toHaveLength(1);
  });

  test("passes ctx.workdir to autoCommitIfDirty", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = commitMakeCtx({ workdir: "/my/project" });

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls[0].workdir).toBe("/my/project");
  });

  test("passes feature name as storyId to autoCommitIfDirty", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = commitMakeCtx();

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls[0].storyId).toBe("my-feature");
  });

  test("passes 'acceptance-setup' as stage to autoCommitIfDirty", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = commitMakeCtx();

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls[0].stage).toBe("acceptance-setup");
  });

  test("passes 'pre-run' as role to autoCommitIfDirty", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    setupGenerationDeps(commitCalls);
    const ctx = commitMakeCtx();

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls[0].role).toBe("pre-run");
  });
});

describe("acceptance-setup: autoCommitIfDirty skipped on fingerprint match", () => {
  test("does NOT call autoCommitIfDirty when fingerprint matches (no regeneration)", async () => {
    const commitCalls: Array<{ workdir: string; stage: string; role: string; storyId: string }> = [];
    const ctx = commitMakeCtx();

    // Compute the real fingerprint so the stored meta matches
    const { computeACFingerprint, computeAcceptanceLayoutFingerprint } = await import(
      "@/pipeline/stages/acceptance-setup"
    );
    const acs = ctx.prd.userStories.flatMap((s) => s.acceptanceCriteria);
    const fingerprint = computeACFingerprint(acs);
    const layoutFingerprint = computeAcceptanceLayoutFingerprint(ctx.workdir, [
      {
        testPath: `${ctx.workdir}/.nax/features/my-feature/.nax-acceptance.test.ts`,
        stories: [{ id: "US-001" }],
      },
    ]);

    setupFingerprintMatchDeps(commitCalls, fingerprint, layoutFingerprint);

    await acceptanceSetupStage.execute(ctx);

    expect(commitCalls).toHaveLength(0);
  });
});
