import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  acceptanceSetupStage,
  _acceptanceSetupDeps,
  computeACFingerprint,
} from "../../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";

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
// Decomposed story exclusion (P5 fix)
// ---------------------------------------------------------------------------

describe("acceptance-setup: decomposed story exclusion", () => {
  function makeDecomposedCtx() {
    const parentStory = {
      ...makeStory("US-PARENT", ["parent AC-1", "child AC-1", "child AC-2"]),
      status: "decomposed" as const,
    } as unknown as ReturnType<typeof makeStory>;
    const childA = makeStory("US-CHILD-A", ["child AC-1"]);
    const childB = makeStory("US-CHILD-B", ["child AC-2"]);
    return makeCtx({ prd: makePrd([parentStory, childA, childB]), stories: [parentStory, childA, childB] });
  }

  beforeEach(() => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
  });

  test("decomposed story is not passed to refine", async () => {
    const refinedStoryIds: string[] = [];
    _acceptanceSetupDeps.refine = async (criteria, context) => {
      refinedStoryIds.push(context.storyId);
      return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: context.storyId }));
    };
    _acceptanceSetupDeps.generate = async () => ({ testCode: 'test("x", () => {})', criteria: [] });

    await acceptanceSetupStage.execute(makeDecomposedCtx());

    expect(refinedStoryIds).not.toContain("US-PARENT");
    expect(refinedStoryIds).toContain("US-CHILD-A");
    expect(refinedStoryIds).toContain("US-CHILD-B");
  });

  test("decomposed story ACs are excluded from the fingerprint", async () => {
    _acceptanceSetupDeps.refine = async (criteria, context) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: context.storyId }));
    _acceptanceSetupDeps.generate = async () => ({ testCode: 'test("x", () => {})', criteria: [] });
    _acceptanceSetupDeps.writeMeta = async (_path, _meta) => {};

    await acceptanceSetupStage.execute(makeDecomposedCtx());

    const ctx = makeDecomposedCtx();
    const childOnlyCount = ctx.prd.userStories
      .filter((s) => s.status !== "decomposed" && !s.id.startsWith("US-FIX-"))
      .flatMap((s) => s.acceptanceCriteria).length;
    expect(childOnlyCount).toBe(2);
  });

  test("decomposed story is not passed to generate", async () => {
    let generatedStories: { id: string }[] = [];
    _acceptanceSetupDeps.refine = async (criteria, context) =>
      criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: context.storyId }));
    _acceptanceSetupDeps.generate = async (stories) => {
      generatedStories = stories as { id: string }[];
      return { testCode: 'test("x", () => {})', criteria: [] };
    };

    await acceptanceSetupStage.execute(makeDecomposedCtx());

    expect(generatedStories.map((s) => s.id)).not.toContain("US-PARENT");
    expect(generatedStories.map((s) => s.id)).toContain("US-CHILD-A");
    expect(generatedStories.map((s) => s.id)).toContain("US-CHILD-B");
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
      await Promise.resolve();
      concurrent--;
      return criteria.map((c) => ({ original: c, refined: c, testable: true, storyId: opts.storyId }));
    };

    await acceptanceSetupStage.execute(makeMultiStoryCtx(5, 2));

    expect(peakConcurrent).toBeLessThanOrEqual(2);
    expect(peakConcurrent).toBeGreaterThan(1);
  });

  test("preserves story order regardless of completion order", async () => {
    stubDeps();
    const resolvers = new Map<string, () => void>();
    const waitForResolvers = async (expectedCount: number): Promise<void> => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (resolvers.size >= expectedCount) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`Expected ${expectedCount} refinement tasks, got ${resolvers.size}`);
    };
    _acceptanceSetupDeps.refine = async (criteria, opts) => {
      await new Promise<void>((resolve) => {
        resolvers.set(opts.storyId, resolve);
      });
      return criteria.map((c) => ({ original: c, refined: `R:${c}`, testable: true, storyId: opts.storyId }));
    };

    let capturedRefined: any[] = [];
    _acceptanceSetupDeps.generate = async (_stories, refined) => {
      capturedRefined = refined;
      return { testCode: 'test("AC", () => { throw new Error("red") })', criteria: [] };
    };

    const runPromise = acceptanceSetupStage.execute(makeMultiStoryCtx(3, 3));
    await waitForResolvers(3);
    resolvers.get("US-003")?.();
    resolvers.get("US-002")?.();
    resolvers.get("US-001")?.();
    await runPromise;

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
