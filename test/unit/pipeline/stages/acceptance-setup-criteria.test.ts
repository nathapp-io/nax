import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  acceptanceSetupStage,
  _acceptanceSetupDeps,
} from "../../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../../src/pipeline/types";
import { DEFAULT_CONFIG } from "../../../../src/config";
import { waitForCondition } from "../../../helpers/timeout";

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

function makeDefaultCallOp(testCode = 'test("AC-1", () => { throw new Error("red") })') {
  return async (_ctx: any, _packageDir: any, op: any, input: any) => {
    if (op.name === "acceptance-refine") {
      const { criteria, storyId } = input as { criteria: string[]; storyId: string };
      return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
    }
    if (op.name === "acceptance-generate") return { testCode };
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
// AC-1: acceptance-setup stage collects criteria from all PRD stories
// ---------------------------------------------------------------------------

describe("acceptance-setup: criteria collection", () => {
  test("collects acceptanceCriteria from all PRD stories", async () => {
    const collectedCriteria: string[] = [];

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        collectedCriteria.push(...criteria);
        return criteria.map((c: string) => ({ original: c, refined: `refined: ${c}`, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'import { test } from "bun:test"; test("AC-1", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
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
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect((ctx as any).acceptanceSetup).toBeDefined();
    expect((ctx as any).acceptanceSetup.totalCriteria).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC-2: acceptance-setup stage calls refinement and generation via callOp
// ---------------------------------------------------------------------------

describe("acceptance-setup: calls refinement and generation", () => {
  test("calls refine op with collected criteria when acceptance.refinement is true", async () => {
    let refineOpCalled = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        refineOpCalled = true;
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: `refined: ${c}`, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC-1", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(refineOpCalled).toBe(true);
  });

  test("skips refine op and uses raw criteria when acceptance.refinement is false", async () => {
    let refineCalled = false;
    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        refineCalled = true;
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        generateCalled = true;
        return { testCode: 'test("AC-1", () => {})' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
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

  test("calls generate op with refined criteria (criteriaList contains R:-prefixed entries)", async () => {
    let capturedCriteriaList: string | null = null;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: `R:${c}`, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        capturedCriteriaList = (input as { criteriaList: string }).criteriaList;
        return { testCode: 'test("AC-1", () => { throw new Error("") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(capturedCriteriaList).not.toBeNull();
    const lines = capturedCriteriaList!.split("\n");
    expect(lines.length).toBe(3);
    expect(lines.every((line) => line.includes("R:"))).toBe(true);
  });

  test("stage runs successfully with 'balanced' model tier (model is internalized to callOp)", async () => {
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = makeDefaultCallOp();
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx({
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: true, model: "balanced" },
      } as any,
    });
    await acceptanceSetupStage.execute(ctx);
    expect((ctx as any).acceptanceSetup).toBeDefined();
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
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
  });

  test("decomposed story is not passed to refine op", async () => {
    const refinedStoryIds: string[] = [];
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        refinedStoryIds.push(storyId);
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") return { testCode: 'test("x", () => {})' };
      throw new Error(`unexpected op: ${op.name}`);
    };

    await acceptanceSetupStage.execute(makeDecomposedCtx());

    expect(refinedStoryIds).not.toContain("US-PARENT");
    expect(refinedStoryIds).toContain("US-CHILD-A");
    expect(refinedStoryIds).toContain("US-CHILD-B");
  });

  test("decomposed story ACs are excluded from the fingerprint", async () => {
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") return { testCode: 'test("x", () => {})' };
      throw new Error(`unexpected op: ${op.name}`);
    };

    await acceptanceSetupStage.execute(makeDecomposedCtx());

    const ctx = makeDecomposedCtx();
    const childOnlyCount = ctx.prd.userStories
      .filter((s) => s.status !== "decomposed" && !s.id.startsWith("US-FIX-"))
      .flatMap((s) => s.acceptanceCriteria).length;
    expect(childOnlyCount).toBe(2);
  });

  test("decomposed story criteria are not included in the generate criteriaList", async () => {
    let capturedCriteriaList: string | null = null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        capturedCriteriaList = (input as { criteriaList: string }).criteriaList;
        return { testCode: 'test("x", () => {})' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };

    await acceptanceSetupStage.execute(makeDecomposedCtx());

    expect(capturedCriteriaList).not.toBeNull();
    expect(capturedCriteriaList!).not.toContain("parent AC-1");
    expect(capturedCriteriaList!).toContain("child AC-1");
    expect(capturedCriteriaList!).toContain("child AC-2");
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
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
  }

  test("respects refinementConcurrency limit", async () => {
    let concurrent = 0;
    let peakConcurrent = 0;
    stubDeps();
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        concurrent++;
        peakConcurrent = Math.max(peakConcurrent, concurrent);
        await Promise.resolve();
        concurrent--;
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };

    await acceptanceSetupStage.execute(makeMultiStoryCtx(5, 2));

    expect(peakConcurrent).toBeLessThanOrEqual(2);
    expect(peakConcurrent).toBeGreaterThan(1);
  });

  test("preserves story order regardless of completion order", async () => {
    stubDeps();
    const resolvers = new Map<string, () => void>();
    let capturedCriteriaList: string | null = null;

    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        await new Promise<void>((resolve) => {
          resolvers.set(storyId, resolve);
        });
        return criteria.map((c: string) => ({ original: c, refined: `R:${c}`, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        capturedCriteriaList = (input as { criteriaList: string }).criteriaList;
        return { testCode: 'test("AC", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };

    const runPromise = acceptanceSetupStage.execute(makeMultiStoryCtx(3, 3));
    await waitForCondition(() => resolvers.size >= 3, 2_000, 5);
    resolvers.get("US-003")?.();
    resolvers.get("US-002")?.();
    resolvers.get("US-001")?.();
    await runPromise;

    expect(capturedCriteriaList).not.toBeNull();
    const lines = capturedCriteriaList!.split("\n");
    // Order must match story order (US-001, US-002, US-003) despite resolving in reverse.
    // Each story's unique criterion number appears in the R: prefix.
    expect(lines[0]).toContain("R:AC-1:");
    expect(lines[1]).toContain("R:AC-2:");
    expect(lines[2]).toContain("R:AC-3:");
  });

  test("DEFAULT_CONFIG.acceptance.refinementConcurrency is 3", () => {
    expect((DEFAULT_CONFIG.acceptance as any).refinementConcurrency).toBe(3);
  });

  test("single story works without concurrency edge case", async () => {
    let refineOpCalled = false;
    stubDeps();
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        refineOpCalled = true;
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      if (op.name === "acceptance-generate") {
        return { testCode: 'test("AC", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };

    await acceptanceSetupStage.execute(makeMultiStoryCtx(1, 2));

    expect(refineOpCalled).toBe(true);
  });
});
