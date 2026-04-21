import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  acceptanceSetupStage,
  _acceptanceSetupDeps,
  computeACFingerprint,
} from "../../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { makeMockAgentManager } from "../../../helpers";

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
    } as any,
    prd: makePrd(stories),
    story: stories[0],
    stories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    rootConfig: DEFAULT_CONFIG,
    workdir: "/tmp/test-workdir",
    projectDir: "/tmp/test-workdir",
    featureDir: "/tmp/test-workdir/.nax/features/test-feature",
    hooks: {} as any,
    ...overrides,
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
// US-004: agentManager.getDefault() is used when ctx.agentManager is set
// ---------------------------------------------------------------------------

describe("US-004: agentManager.getDefault() is called when ctx.agentManager is set", () => {
  test("ctx.agentManager.getDefault() is used for model resolution", async () => {
    let getDefaultCalled = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const mockAgentManager = makeMockAgentManager({
      run: mock(async () => ({ output: "", costUsd: 0 })),
      complete: mock(async () => ({ output: "", costUsd: 0 })),
    });
    (mockAgentManager as any).getDefault = () => {
      getDefaultCalled = true;
      return "claude";
    };

    const ctx = makeCtx({
      agentManager: mockAgentManager,
    });

    await acceptanceSetupStage.execute(ctx);

    expect(getDefaultCalled).toBe(true);
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

  test("does not regenerate when fingerprint matches — reuse path taken", async () => {
    let refineCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: matchingFingerprint(),
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.refine = async () => {
      refineCalled = true;
      return [];
    };
    _acceptanceSetupDeps.generate = async () => ({ testCode: "", criteria: [] });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(refineCalled).toBe(false);
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
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
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
    _acceptanceSetupDeps.refine = async (criteria, context) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: context.storyId }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async (p) => {
      writtenPaths.push(p);
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
    _acceptanceSetupDeps.refine = async (criteria, context) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: context.storyId }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async (p) => {
      writtenPaths.push(p);
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
    _acceptanceSetupDeps.refine = async (criteria, context) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: context.storyId }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
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
    _acceptanceSetupDeps.refine = async (criteria, context) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: context.storyId }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(ctx);

    expect(ctx.acceptanceTestPaths).toBeDefined();
    expect(ctx.acceptanceTestPaths!.length).toBe(2);
    expect(ctx.acceptanceTestPaths!.every((p) => p.testPath && p.packageDir)).toBe(true);
    expect(ctx.acceptanceTestPaths!.some((p) => p.packageDir.endsWith("apps/api"))).toBe(true);
    expect(ctx.acceptanceTestPaths!.some((p) => p.packageDir.endsWith("apps/cli"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// US-003 AC-10: semantic-verdicts/ cleared on fingerprint mismatch
// ---------------------------------------------------------------------------

describe("US-003: semantic-verdicts cleared on fingerprint mismatch", () => {
  test("calls deleteSemanticVerdicts when fingerprint mismatches", async () => {
    let deleteSemanticVerdictsCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: "sha256:outdated",
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.deleteSemanticVerdicts = async () => {
      deleteSemanticVerdictsCalled = true;
    };
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(deleteSemanticVerdictsCalled).toBe(true);
  });

  test("passes featureDir to deleteSemanticVerdicts", async () => {
    let capturedFeatureDir = "";

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: "sha256:outdated",
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.deleteSemanticVerdicts = async (featureDir) => {
      capturedFeatureDir = featureDir;
    };
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => {})',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(capturedFeatureDir).toBe(ctx.featureDir);
  });

  test("does not call deleteSemanticVerdicts when fingerprint matches", async () => {
    let deleteSemanticVerdictsCalled = false;

    const criteria = ["AC-1: first criterion", "AC-2: second criterion", "AC-1: third criterion"];
    const matchingFingerprint = computeACFingerprint(criteria);

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: matchingFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.deleteSemanticVerdicts = async () => {
      deleteSemanticVerdictsCalled = true;
    };
    _acceptanceSetupDeps.refine = async () => [];
    _acceptanceSetupDeps.generate = async () => ({ testCode: "", criteria: [] });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(deleteSemanticVerdictsCalled).toBe(false);
  });
});
