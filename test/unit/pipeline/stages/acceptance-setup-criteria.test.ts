import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeDispatchContext,
  makeNaxConfig,
  makePRD,
  makeTempDir,
  makeStory as profileChainMakeStory,
  waitForCondition,
} from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import { _clearRootConfigCache } from "@/config/loader";
import { _acceptanceSetupDeps, acceptanceSetupStage } from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(id: string, acceptanceCriteria: string[], status: "pending" | "decomposed" = "pending") {
  return {
    id,
    title: `Story ${id}`,
    description: "desc",
    acceptanceCriteria,
    tags: [],
    dependencies: [],
    status,
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
    config: makeNaxConfig({
      acceptance: {
        enabled: true,
        refinement: true,
        redGate: true,
        model: "fast",
      },
    }),
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

function makeDefaultCallOp(testCode = 'test("AC-1", () => { throw new Error("red") })') {
  type SetupCallOp = typeof _acceptanceSetupDeps.callOp;
  return async (
    _ctx: Parameters<SetupCallOp>[0],
    _packageDir: Parameters<SetupCallOp>[1],
    op: Parameters<SetupCallOp>[2],
    input: Parameters<SetupCallOp>[3],
  ) => {
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

    expect(ctx.acceptanceSetup).toBeDefined();
    expect(ctx.acceptanceSetup?.totalCriteria).toBe(3);
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
      config: makeNaxConfig({
        acceptance: { enabled: true, refinement: false, redGate: true },
      }),
    });
    await acceptanceSetupStage.execute(ctx);

    expect(refineCalled).toBe(false);
    expect(generateCalled).toBe(true);
  });

  test("calls generate op with refined criteria (criteriaList contains R:-prefixed entries)", async () => {
    let capturedCriteriaList: string | undefined;

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
    assertDefined(capturedCriteriaList, "capturedCriteriaList");
    const lines = capturedCriteriaList.split("\n");
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
      config: makeNaxConfig({
        acceptance: { enabled: true, refinement: true, model: "balanced" },
      }),
    });
    await acceptanceSetupStage.execute(ctx);
    expect(ctx.acceptanceSetup).toBeDefined();
  });

  test("falls back to unrefined criteria when refine op throws (e.g. after retry exhaustion)", async () => {
    let capturedCriteriaList: string | undefined;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-refine") {
        throw new Error("acceptance-refine: empty output");
      }
      if (op.name === "acceptance-generate") {
        capturedCriteriaList = (input as { criteriaList: string }).criteriaList;
        return { testCode: 'test("AC-1", () => { throw new Error("red") })' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    // generate must still run — with the original (unrefined) AC text
    expect(capturedCriteriaList).not.toBeNull();
    assertDefined(capturedCriteriaList, "capturedCriteriaList");
    expect(capturedCriteriaList).toContain("AC-1: first criterion");
    expect(capturedCriteriaList).toContain("AC-2: second criterion");
    expect(capturedCriteriaList).toContain("AC-1: third criterion");
  });
});

// ---------------------------------------------------------------------------
// Decomposed story exclusion (P5 fix)
// ---------------------------------------------------------------------------

describe("acceptance-setup: decomposed story exclusion", () => {
  function makeDecomposedCtx() {
    const parentStory = makeStory("US-PARENT", ["parent AC-1", "child AC-1", "child AC-2"], "decomposed");
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
    let capturedCriteriaList: string | undefined;
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
    assertDefined(capturedCriteriaList, "capturedCriteriaList");
    expect(capturedCriteriaList).not.toContain("parent AC-1");
    expect(capturedCriteriaList).toContain("child AC-1");
    expect(capturedCriteriaList).toContain("child AC-2");
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
      config: makeNaxConfig({
        acceptance: {
          enabled: true,
          refinement: true,
          redGate: true,
          ...(refinementConcurrency !== undefined ? { refinementConcurrency } : {}),
        },
      }),
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
    let capturedCriteriaList: string | undefined;

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
    assertDefined(capturedCriteriaList, "capturedCriteriaList");
    const lines = capturedCriteriaList.split("\n");
    // Order must match story order (US-001, US-002, US-003) despite resolving in reverse.
    // Each story's unique criterion number appears in the R: prefix.
    expect(lines[0]).toContain("R:AC-1:");
    expect(lines[1]).toContain("R:AC-2:");
    expect(lines[2]).toContain("R:AC-3:");
  });

  test("DEFAULT_CONFIG.acceptance.refinementConcurrency is 3", () => {
    expect(DEFAULT_CONFIG.acceptance.refinementConcurrency).toBe(3);
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

// ---------------------------------------------------------------------------
// Absorbed: acceptance-setup-profile-chain.test.ts
// ---------------------------------------------------------------------------

const PKG = "packages/core";
const PROFILE = "fixture-native";
const NATIVE_FAST = "minimax/MiniMax-M2.7";

const origDeps = { ..._acceptanceSetupDeps };

/** Repo config declares only `models.claude`; everything native arrives via the profile. */
function writeRepo(root: string): void {
  mkdirSync(join(root, ".nax", "profiles"), { recursive: true });
  mkdirSync(join(root, PKG), { recursive: true });
  writeFileSync(
    join(root, ".nax", "config.json"),
    JSON.stringify({ models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "sonnet" } } }),
  );
  writeFileSync(
    join(root, ".nax", "profiles", `${PROFILE}.json`),
    JSON.stringify({
      // protocol "hybrid" is required by the schema for a `models.native` entry.
      agent: { default: "native", protocol: "hybrid" },
      models: {
        claude: { fast: "haiku", balanced: "sonnet", powerful: "sonnet" },
        native: { fast: NATIVE_FAST, balanced: NATIVE_FAST, powerful: "minimax/MiniMax-M3" },
      },
    }),
  );
}

describe("acceptance-setup: group config inherits the run's profile chain (nax#2126)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-accept-profile-");
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    writeRepo(tempDir);
    _clearRootConfigCache();
  });

  afterEach(() => {
    Object.assign(_acceptanceSetupDeps, origDeps);
    cleanupTempDir(tempDir);
    // Assigning `undefined` would store the STRING "undefined" and leak a bogus
    // path into every later test in this process.
    if (originalGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
    else process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    _clearRootConfigCache();
    mock.restore();
  });

  test("the config handed to callOp for a package group carries the profile's model map", async () => {
    const seen: Array<{ packageDir: string; nativeFast: unknown }> = [];

    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
    _acceptanceSetupDeps.callOp = async (_ctx, packageDir, op, input, _storyId, config) => {
      seen.push({ packageDir, nativeFast: config?.models?.native?.fast });
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      return { testCode: 'import { test } from "bun:test";\ntest("AC-1", () => {});\n' };
    };

    const story = profileChainMakeStory({ id: "US-001", workdir: PKG, acceptanceCriteria: ["AC-1: config surface"] });
    const prd = makePRD({ feature: "test-feature", userStories: [story] });
    const ctx: PipelineContext = {
      config: {
        ...DEFAULT_CONFIG,
        profileChain: [PROFILE],
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: true, redGate: true },
      },
      prd,
      story,
      stories: [story],
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      rootConfig: DEFAULT_CONFIG,
      workdir: tempDir,
      projectDir: tempDir,
      featureDir: join(tempDir, ".nax", "features", "test-feature"),
      hooks: { hooks: {} },
      ...makeDispatchContext(),
    };

    await acceptanceSetupStage.execute(ctx);

    // Both the refine and the generate dispatch must see the profile-resolved map.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.packageDir === join(tempDir, PKG))).toBe(true);
    for (const s of seen) expect(s.nativeFast).toBe(NATIVE_FAST);
  });
});
