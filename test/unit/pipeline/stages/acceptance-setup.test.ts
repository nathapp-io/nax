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

// ---------------------------------------------------------------------------
// Saved original deps for restoration after each test
// ---------------------------------------------------------------------------

let savedDeps: typeof _acceptanceSetupDeps;

beforeEach(() => {
  savedDeps = { ..._acceptanceSetupDeps };
});

afterEach(() => {
  Object.assign(_acceptanceSetupDeps, savedDeps);
  mock.restore();
});

// ---------------------------------------------------------------------------
// AC-1: acceptance-setup stage collects criteria from all PRD stories
// ---------------------------------------------------------------------------

describe("acceptance-setup: criteria collection", () => {
  test("collects acceptanceCriteria from all PRD stories", async () => {
    const collectedCriteria: string[] = [];

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria, _ctx) => {
      collectedCriteria.push(...criteria);
      return criteria.map((c, i) => ({
        original: c,
        refined: `refined: ${c}`,
        testable: true,
        storyId: `US-00${i + 1}`,
      }));
    };
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'import { test } from "bun:test"; test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    // All criteria from both stories must be collected
    expect(collectedCriteria).toContain("AC-1: first criterion");
    expect(collectedCriteria).toContain("AC-2: second criterion");
    expect(collectedCriteria).toContain("AC-1: third criterion");
    expect(collectedCriteria.length).toBe(3);
  });

  test("stores totalCriteria count in ctx.acceptanceSetup", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c, i) => ({ original: c, refined: c, testable: true, storyId: `US-00${i + 1}` }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect((ctx as any).acceptanceSetup).toBeDefined();
    expect((ctx as any).acceptanceSetup.totalCriteria).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC-2: acceptance-setup calls refinement and generation modules
// ---------------------------------------------------------------------------

describe("acceptance-setup: calls refinement and generation", () => {
  test("calls refine with collected criteria when acceptance.refinement is true", async () => {
    let refineCalled = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) => {
      refineCalled = true;
      return criteria.map((c) => ({ original: c, refined: `refined: ${c}`, testable: true, storyId: "US-001" }));
    };
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(refineCalled).toBe(true);
  });

  test("skips refine and uses raw criteria when acceptance.refinement is false", async () => {
    let refineCalled = false;
    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) => {
      refineCalled = true;
      return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    };
    _acceptanceSetupDeps.generate = async (_stories, refined) => {
      generateCalled = true;
      // When refinement disabled, refined text should match original
      expect(refined[0].refined).toBe(refined[0].original);
      return { testCode: 'test("AC-1", () => {})', criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: false, redGate: true },
      } as any,
    });
    await acceptanceSetupStage.execute(ctx);

    expect(refineCalled).toBe(false);
    expect(generateCalled).toBe(true);
  });

  test("calls generate with PRD stories and refined criteria", async () => {
    let generateArgs: { stories: unknown[]; refined: unknown[] } | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: `R:${c}`, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async (stories, refined) => {
      generateArgs = { stories, refined };
      return { testCode: 'test("AC-1", () => { throw new Error("") })', criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(generateArgs).not.toBeNull();
    expect(generateArgs!.stories.length).toBe(2);
    expect(generateArgs!.refined.length).toBe(3);
    // Refined text should be used (prefixed with "R:")
    expect((generateArgs!.refined[0] as any).refined).toStartWith("R:");
  });

  test("passes acceptance.model tier into generator options", async () => {
    let receivedModelTier: string | undefined;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async (_stories, _refined, options) => {
      receivedModelTier = options?.modelTier;
      return { testCode: 'test("AC-1", () => { throw new Error("") })', criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: true, model: "balanced" },
      } as any,
    });
    await acceptanceSetupStage.execute(ctx);

    expect(receivedModelTier).toBe("balanced");
  });
});

// ---------------------------------------------------------------------------
// Refinement bounded concurrency (#226)
// ---------------------------------------------------------------------------

describe("acceptance-setup: refinement concurrency", () => {
  function makeMultiStoryCtx(storyCount: number, refinementConcurrency?: number) {
    const stories = Array.from({ length: storyCount }, (_, i) =>
      makeStory(`US-${String(i + 1).padStart(3, "0")}`, [`AC-${i + 1}: criterion`]),
    );
    return makeCtx({
      prd: makePrd(stories),
      stories,
      story: stories[0],
      config: {
        ...DEFAULT_CONFIG,
        acceptance: {
          ...DEFAULT_CONFIG.acceptance,
          enabled: true,
          refinement: true,
          redGate: true,
          ...(refinementConcurrency !== undefined ? { refinementConcurrency } : {}),
        },
      } as any,
    });
  }

  function stubDeps() {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
  }

  test("respects refinementConcurrency limit", async () => {
    let concurrent = 0;
    let peakConcurrent = 0;
    stubDeps();
    _acceptanceSetupDeps.refine = async (criteria, opts) => {
      concurrent++;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      await Bun.sleep(10);
      concurrent--;
      return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: opts.storyId }));
    };

    await acceptanceSetupStage.execute(makeMultiStoryCtx(5, 2));

    expect(peakConcurrent).toBeLessThanOrEqual(2);
    expect(peakConcurrent).toBeGreaterThan(1); // actually ran concurrently
  });

  test("preserves story order regardless of completion order", async () => {
    const completionOrder: string[] = [];
    stubDeps();
    // Story 3 resolves fastest, story 1 slowest
    const delays: Record<string, number> = { "US-001": 30, "US-002": 20, "US-003": 10 };
    _acceptanceSetupDeps.refine = async (criteria, opts) => {
      await Bun.sleep(delays[opts.storyId] ?? 10);
      completionOrder.push(opts.storyId);
      return criteria.map((c) => ({ original: c, refined: `R:${c}`, testable: true, storyId: opts.storyId }));
    };

    let capturedRefined: any[] = [];
    _acceptanceSetupDeps.generate = async (_stories, refined) => {
      capturedRefined = refined;
      return { testCode: 'test("AC", () => { throw new Error("red") })', criteria: [] };
    };

    await acceptanceSetupStage.execute(makeMultiStoryCtx(3, 3));

    // Completion order is non-deterministic, but output order must match story order
    expect(capturedRefined.map((r: any) => r.storyId)).toEqual(["US-001", "US-002", "US-003"]);
  });

  test("DEFAULT_CONFIG.acceptance.refinementConcurrency is 3", () => {
    expect((DEFAULT_CONFIG.acceptance as any).refinementConcurrency).toBe(3);
  });

  test("single story works without concurrency edge case", async () => {
    let refineCalled = false;
    stubDeps();
    _acceptanceSetupDeps.refine = async (criteria, opts) => {
      refineCalled = true;
      return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: opts.storyId }));
    };

    await acceptanceSetupStage.execute(makeMultiStoryCtx(1, 2));

    expect(refineCalled).toBe(true);
  });
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
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({ testCode, criteria: [] });
    _acceptanceSetupDeps.writeFile = async (path) => {
      writtenPaths.push(path);
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(writtenPaths.length).toBe(1);
    // BUG-186 regression: file must be under .nax/features/<featureName>/, not the bare package root
    expect(writtenPaths[0]).toContain(".nax/features/test-feature/.nax-acceptance.test.ts");
    expect(writtenPaths[0]).toContain("/tmp/test-workdir");
  });

  test("written content matches generated testCode", async () => {
    let writtenContent = "";
    const testCode = 'test("AC-1: first criterion", () => { throw new Error("NOT_IMPLEMENTED") })';

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({ testCode, criteria: [] });
    _acceptanceSetupDeps.writeFile = async (_path, content) => {
      writtenContent = content;
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
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail\n0 pass" });

    const ctx = makeCtx();
    const result = await acceptanceSetupStage.execute(ctx);

    expect(result.action).toBe("continue");
  });

  test("stores redFailCount in ctx.acceptanceSetup when tests fail", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
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
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
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
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { /* already passes */ })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 0, output: "3 pass" });

    const ctx = makeCtx();
    const result = await acceptanceSetupStage.execute(ctx);

    // Tests passing means they're not testing new behavior — skip acceptance
    expect(result.action).toBe("skip");
  });

  test("skip result includes a human-readable reason", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.refine = async (criteria) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: "US-001" }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => {})',
      criteria: [],
    });
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
  // Helper: compute the fingerprint that matches the default makeCtx() criteria
  function matchingFingerprint() {
    const criteria = ["AC-1: first criterion", "AC-2: second criterion", "AC-1: third criterion"];
    return computeACFingerprint(criteria);
  }

  test("does not call refine or generate when acceptance.test.ts already exists and fingerprint matches", async () => {
    let refineCalled = false;
    let generateCalled = false;

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
    _acceptanceSetupDeps.generate = async () => {
      generateCalled = true;
      return { testCode: "", criteria: [] };
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(refineCalled).toBe(false);
    expect(generateCalled).toBe(false);
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
    _acceptanceSetupDeps.refine = async () => [];
    _acceptanceSetupDeps.generate = async () => ({ testCode: "", criteria: [] });
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
    _acceptanceSetupDeps.refine = async () => [];
    _acceptanceSetupDeps.generate = async () => ({ testCode: "", criteria: [] });
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
// AC-8: Existing acceptance stage (GREEN gate) works with pre-generated test file
// ---------------------------------------------------------------------------

describe("acceptance stage (GREEN gate): works with pre-generated test file", () => {
  test("acceptance stage runs bun test without requiring spec.md parsing", async () => {
    const { acceptanceStage } = await import("../../../../src/pipeline/stages/acceptance");

    // Test behavior through the enabled/execute interface
    const stories = [makeStory("US-001", ["AC-1: criterion"])];
    stories[0].status = "passed" as any;

    const ctx = makeCtx({
      prd: makePrd(stories) as any,
      story: stories[0],
      featureDir: "/tmp/fake-feature-dir",
    });

    // GREEN gate: enabled when all stories complete and acceptance enabled
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
// ctx.acceptanceSetup: testableCount reflects criteria marked testable
// ---------------------------------------------------------------------------

describe("acceptanceSetup context: testableCount", () => {
  test("testableCount counts only testable criteria", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    // With per-story calls: US-001 has 2 testable criteria, US-002 has 1 non-testable
    _acceptanceSetupDeps.refine = async (criteria, context) =>
      criteria.map((c) => ({
        original: c,
        refined: c,
        testable: context.storyId === "US-001",
        storyId: context.storyId,
      }));
    _acceptanceSetupDeps.generate = async () => ({
      testCode: 'test("AC-1", () => { throw new Error("red") })',
      criteria: [],
    });
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "2 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect((ctx as any).acceptanceSetup.totalCriteria).toBe(3);
    expect((ctx as any).acceptanceSetup.testableCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// US-004: agentGetFn from ctx is used over _acceptanceSetupDeps.getAgent
// ---------------------------------------------------------------------------

describe("US-004: agentGetFn from ctx overrides _acceptanceSetupDeps.getAgent", () => {
  test("ctx.agentGetFn is called when set, not _acceptanceSetupDeps.getAgent", async () => {
    let ctxAgentGetFnCalled = false;
    let depsGetAgentCalled = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.getAgent = (_name: string) => {
      depsGetAgentCalled = true;
      return undefined;
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

    const ctx = makeCtx({
      agentGetFn: (name: string) => {
        ctxAgentGetFnCalled = true;
        return undefined;
      },
    } as any);

    await acceptanceSetupStage.execute(ctx);

    expect(ctxAgentGetFnCalled).toBe(true);
    expect(depsGetAgentCalled).toBe(false);
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

    const ctx = makeCtx(); // default makeCtx has stories with no workdir
    await acceptanceSetupStage.execute(ctx);

    expect(writtenPaths.length).toBe(1);
    // BUG-186 regression: file must be under .nax/features/<featureName>/ (not bare package root)
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

    // Each test file must be run from its package directory
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
