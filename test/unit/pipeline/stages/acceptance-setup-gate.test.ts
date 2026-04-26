import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  acceptanceSetupStage,
  _acceptanceSetupDeps,
  computeACFingerprint,
} from "../../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { preRunPipeline } from "../../../../src/pipeline/stages/index";

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

/** Standard callOp mock for tests that just need generation to work. */
function makeDefaultCallOp(testCode = 'test("AC-1", () => { throw new Error("red") })') {
  return async (_ctx: any, _packageDir: any, op: any, input: any) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") {
      return { testCode };
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
// AC-3: acceptance-setup writes acceptance.test.ts to feature directory
// ---------------------------------------------------------------------------

describe("acceptance-setup: writes test file", () => {
  test("writes .nax-acceptance.test.ts under .nax/features/<featureName>/", async () => {
    const writtenPaths: string[] = [];
    const testCode = 'import { test } from "bun:test"; test("AC-1", () => { throw new Error("red") })';

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp(testCode);
    _acceptanceSetupDeps.writeFile = async (path) => {
      if (path.endsWith(".nax-acceptance.test.ts")) writtenPaths.push(path);
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(writtenPaths.length).toBe(1);
    expect(writtenPaths[0]).toContain(".nax/features/test-feature/.nax-acceptance.test.ts");
    expect(writtenPaths[0]).toContain("/tmp/test-workdir");
  });

  test("written content matches generated testCode", async () => {
    let writtenContent = "";
    const testCode = 'test("AC-1: first criterion", () => { throw new Error("NOT_IMPLEMENTED") })';

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") return { testCode };
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async (path, content) => {
      if (path.endsWith(".nax-acceptance.test.ts")) writtenContent = content;
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(writtenContent).toBe(testCode);
  });

  test("returns fail when featureDir is not set", async () => {
    const ctx = makeCtx({ featureDir: undefined });
    const result = await acceptanceSetupStage.execute(ctx);
    expect(result.action).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// AC-4: RED gate — tests that fail (exit != 0) are valid RED, stage continues
// ---------------------------------------------------------------------------

describe("acceptance-setup: RED gate — failing tests", () => {
  test("returns continue when bun test exits with code 1", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail\n0 pass" });

    const ctx = makeCtx();
    const result = await acceptanceSetupStage.execute(ctx);

    expect(result.action).toBe("continue");
  });

  test("stores redFailCount in ctx.acceptanceSetup when tests fail", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "3 fail\n0 pass" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect((ctx as any).acceptanceSetup).toBeDefined();
    expect((ctx as any).acceptanceSetup.redFailCount).toBeGreaterThan(0);
  });

  test("RED gate skipped when acceptance.redGate is false — stage continues without running tests", async () => {
    let testRunCalled = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => {
      testRunCalled = true;
      return { exitCode: 0, output: "" };
    };

    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: true, redGate: false },
      } as any,
    });
    const result = await acceptanceSetupStage.execute(ctx);

    expect(testRunCalled).toBe(false);
    expect(result.action).toBe("continue");
  });
});

// ---------------------------------------------------------------------------
// AC-5: RED gate — tests that pass (exit == 0) trigger warning and skip acceptance
// ---------------------------------------------------------------------------

describe("acceptance-setup: RED gate — passing tests (invalid RED)", () => {
  test("returns skip when bun test exits with code 0", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp('test("AC-1", () => { /* already passes */ })');
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 0, output: "3 pass" });

    const ctx = makeCtx();
    const result = await acceptanceSetupStage.execute(ctx);

    expect(result.action).toBe("skip");
  });

  test("skip result includes a human-readable reason", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp('test("AC-1", () => {})');
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 0, output: "3 pass" });

    const ctx = makeCtx();
    const result = await acceptanceSetupStage.execute(ctx);

    expect(result.action).toBe("skip");
    if (result.action === "skip") {
      expect(result.reason).toBeTruthy();
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-6: Skips generation if acceptance.test.ts already exists
// ---------------------------------------------------------------------------

describe("acceptance-setup: skips generation when test file exists and fingerprint matches", () => {
  function matchingFingerprint() {
    const criteria = ["AC-1: first criterion", "AC-2: second criterion", "AC-1: third criterion"];
    return computeACFingerprint(criteria);
  }

  test("does not call callOp when acceptance.test.ts already exists and fingerprint matches", async () => {
    let callOpCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: matchingFingerprint(),
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, _input) => {
      callOpCalled = true;
      if (op.name === "acceptance-generate") return { testCode: "" };
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(callOpCalled).toBe(false);
  });

  test("proceeds directly to RED gate when test file exists and fingerprint matches", async () => {
    let testRunCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: matchingFingerprint(),
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, _input) => {
      if (op.name === "acceptance-generate") return { testCode: "" };
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => {
      testRunCalled = true;
      return { exitCode: 1, output: "1 fail" };
    };

    const ctx = makeCtx();
    const result = await acceptanceSetupStage.execute(ctx);

    expect(testRunCalled).toBe(true);
    expect(result.action).toBe("continue");
  });

  test("does not overwrite existing acceptance.test.ts when fingerprint matches", async () => {
    let writeFileCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: matchingFingerprint(),
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, _input) => {
      if (op.name === "acceptance-generate") return { testCode: "" };
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {
      writeFileCalled = true;
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(writeFileCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-7: Config defaults — acceptance.refinement, acceptance.redGate, acceptance.model
// ---------------------------------------------------------------------------

describe("config defaults: acceptance.refinement, acceptance.redGate, acceptance.model", () => {
  test("DEFAULT_CONFIG.acceptance.refinement is true", () => {
    expect((DEFAULT_CONFIG.acceptance as any).refinement).toBe(true);
  });

  test("DEFAULT_CONFIG.acceptance.redGate is true", () => {
    expect((DEFAULT_CONFIG.acceptance as any).redGate).toBe(true);
  });

  test("DEFAULT_CONFIG.acceptance.model is 'fast'", () => {
    expect(DEFAULT_CONFIG.acceptance.model).toBe("fast");
  });
});

// ---------------------------------------------------------------------------
// Stage interface: enabled()
// ---------------------------------------------------------------------------

describe("acceptanceSetupStage.enabled()", () => {
  test("enabled when acceptance.enabled is true and featureDir is set", () => {
    const ctx = makeCtx();
    expect(acceptanceSetupStage.enabled(ctx)).toBe(true);
  });

  test("disabled when acceptance.enabled is false", () => {
    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: false },
      } as any,
    });
    expect(acceptanceSetupStage.enabled(ctx)).toBe(false);
  });

  test("disabled when featureDir is not set", () => {
    const ctx = makeCtx({ featureDir: undefined });
    expect(acceptanceSetupStage.enabled(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-8: Existing acceptance stage (GREEN gate) works with pre-generated test file
// ---------------------------------------------------------------------------

describe("acceptance stage (GREEN gate): works with pre-generated test file", () => {
  test("acceptance stage runs bun test without requiring spec.md parsing", async () => {
    const { acceptanceStage } = await import("../../../../src/pipeline/stages/acceptance");

    const stories = [makeStory("US-001", ["AC-1: criterion"])];
    stories[0].status = "passed" as any;

    const ctx = makeCtx({
      prd: makePrd(stories) as any,
      story: stories[0],
      featureDir: "/tmp/fake-feature-dir",
    });

    expect(acceptanceStage.enabled(ctx)).toBe(true);
  });

  test("acceptance stage returns continue when test file does not exist", async () => {
    const { acceptanceStage } = await import("../../../../src/pipeline/stages/acceptance");

    const stories = [makeStory("US-001", ["AC-1"])];
    stories[0].status = "passed" as any;

    const ctx = makeCtx({
      prd: makePrd(stories) as any,
      story: stories[0],
      featureDir: "/tmp/non-existent-feature-dir",
    });

    const result = await acceptanceStage.execute(ctx);
    expect(result.action).toBe("continue");
  });
});

// ---------------------------------------------------------------------------
// AC-9: preRunPipeline wired into runner — exported from stages/index.ts
// ---------------------------------------------------------------------------

describe("preRunPipeline export", () => {
  test("preRunPipeline is exported from src/pipeline/stages/index.ts", () => {
    expect(preRunPipeline).toBeDefined();
    expect(Array.isArray(preRunPipeline)).toBe(true);
  });

  test("preRunPipeline contains acceptanceSetupStage", () => {
    const stageNames = preRunPipeline.map((s) => s.name);
    expect(stageNames).toContain("acceptance-setup");
  });

  test("preRunPipeline has acceptanceSetupStage as first entry", () => {
    expect(preRunPipeline[0].name).toBe("acceptance-setup");
  });
});

// ---------------------------------------------------------------------------
// ctx.acceptanceSetup: testableCount reflects criteria marked testable
// ---------------------------------------------------------------------------

describe("acceptanceSetup context: testableCount", () => {
  test("testableCount counts only testable criteria", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({
          original: c,
          refined: c,
          testable: storyId === "US-001",
          storyId,
        }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "2 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect((ctx as any).acceptanceSetup.totalCriteria).toBe(3);
    expect((ctx as any).acceptanceSetup.testableCount).toBe(2);
  });
});
