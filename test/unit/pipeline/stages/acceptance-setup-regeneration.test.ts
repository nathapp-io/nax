/**
 * acceptance-setup: P2-A/P2-B — Hash-based regeneration tests
 *
 * Verifies that acceptance-setup detects stale test files via AC fingerprint
 * and regenerates them (with .bak backup) when ACs change.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeStory as dispatchRootMakeStory,
  makeDispatchContext,
  makeMockAgentManager,
  makePRD,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { groupStoriesByPackage } from "@/acceptance";
import type { AgentRunOptions } from "@/agents/types";
import { DEFAULT_CONFIG, pickSelector } from "@/config";
import type { RunOperation } from "@/operations";
import {
  _acceptanceSetupDeps,
  type AcceptanceMeta,
  acceptanceSetupStage,
  computeACFingerprint,
  computeAcceptanceLayoutFingerprint,
} from "@/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD } from "@/prd/types";
import type { NaxRuntime } from "@/runtime";
import { storyExecRoot } from "@/runtime/packages";

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
    makeStory("US-002", ["AC-3: third criterion"]),
  ];
  return {
    config: {
      ...DEFAULT_CONFIG,
      acceptance: {
        ...DEFAULT_CONFIG.acceptance,
        enabled: true,
        refinement: false,
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

// Criteria in default makeCtx
const DEFAULT_CRITERIA = ["AC-1: first criterion", "AC-2: second criterion", "AC-3: third criterion"];

function rootLayoutFingerprint(ctx: PipelineContext, stories = ctx.prd.userStories): string {
  return computeAcceptanceLayoutFingerprint(ctx.workdir, [
    {
      testPath: `${ctx.workdir}/.nax/features/${ctx.prd.feature}/.nax-acceptance.test.ts`,
      stories,
    },
  ]);
}

// ---------------------------------------------------------------------------
// Save/restore deps
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
// computeACFingerprint — P2-A unit tests
// ---------------------------------------------------------------------------

describe("computeACFingerprint", () => {
  test("returns a sha256: prefixed string", () => {
    const fp = computeACFingerprint(["AC-1: criterion"]);
    expect(fp).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("same criteria produce same fingerprint", () => {
    const fp1 = computeACFingerprint(["AC-1: a", "AC-2: b"]);
    const fp2 = computeACFingerprint(["AC-1: a", "AC-2: b"]);
    expect(fp1).toBe(fp2);
  });

  test("order-independent — sorts before hashing", () => {
    const fp1 = computeACFingerprint(["AC-1: a", "AC-2: b"]);
    const fp2 = computeACFingerprint(["AC-2: b", "AC-1: a"]);
    expect(fp1).toBe(fp2);
  });

  test("different criteria produce different fingerprints", () => {
    const fp1 = computeACFingerprint(["AC-1: original"]);
    const fp2 = computeACFingerprint(["AC-1: modified"]);
    expect(fp1).not.toBe(fp2);
  });

  test("empty array produces stable fingerprint", () => {
    const fp = computeACFingerprint([]);
    expect(fp).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// P2-A: Regenerate when meta is missing
// ---------------------------------------------------------------------------

describe("acceptance-setup: regenerates when meta is missing (P2-A)", () => {
  test("calls generate when file exists but meta is missing", async () => {
    let generateCalled = false;
    let copyFileCalled = false;
    let deleteFileCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => null; // no meta
    _acceptanceSetupDeps.copyFile = async () => {
      copyFileCalled = true;
    };
    _acceptanceSetupDeps.deleteFile = async () => {
      deleteFileCalled = true;
    };
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-generate") {
        generateCalled = true;
        return { testCode: 'test("AC-1", () => {})' };
      }
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(copyFileCalled).toBe(true);
    expect(deleteFileCalled).toBe(true);
    expect(generateCalled).toBe(true);
  });

  test("backs up test file before regenerating when meta is missing", async () => {
    const copySrc: string[] = [];
    const copyDest: string[] = [];

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.copyFile = async (src, dest) => {
      copySrc.push(src);
      copyDest.push(dest);
    };
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-generate") return { testCode: 'test("AC-1", () => {})' };
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(copySrc[0]).toContain("acceptance.test.ts");
    expect(copyDest[0]).toContain("acceptance.test.ts.bak");
  });
});

// ---------------------------------------------------------------------------
// P2-A: Regenerate when fingerprint is stale
// ---------------------------------------------------------------------------

describe("acceptance-setup: regenerates when fingerprint is stale (P2-A)", () => {
  test("regenerates when stored fingerprint differs from current ACs", async () => {
    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: "sha256:outdated_fingerprint",
      storyCount: 2,
      acCount: 2,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-generate") {
        generateCalled = true;
        return { testCode: 'test("AC-1", () => {})' };
      }
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(generateCalled).toBe(true);
  });

  test("adding a new AC triggers regeneration (AC-12)", async () => {
    const originalCriteria = DEFAULT_CRITERIA;
    const storedFingerprint = computeACFingerprint(originalCriteria);

    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: storedFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-generate") {
        generateCalled = true;
        return { testCode: 'test("AC-1", () => {})' };
      }
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    // Add a new AC to the context
    const stories = [
      makeStory("US-001", ["AC-1: first criterion", "AC-2: second criterion"]),
      makeStory("US-002", ["AC-3: third criterion", "AC-4: new criterion"]), // extra AC
    ];
    const ctx = makeCtx({ prd: makePrd(stories) });

    await acceptanceSetupStage.execute(ctx);

    expect(generateCalled).toBe(true);
  });

  test("modifying an AC triggers regeneration (AC-14)", async () => {
    const storedFingerprint = computeACFingerprint(DEFAULT_CRITERIA);

    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: storedFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-generate") {
        generateCalled = true;
        return { testCode: 'test("AC-1", () => {})' };
      }
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    // Modified AC text
    const stories = [
      makeStory("US-001", ["AC-1: first criterion MODIFIED", "AC-2: second criterion"]),
      makeStory("US-002", ["AC-3: third criterion"]),
    ];
    const ctx = makeCtx({ prd: makePrd(stories) });

    await acceptanceSetupStage.execute(ctx);

    expect(generateCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix-story exclusion: US-FIX-* stories don't affect fingerprint
// ---------------------------------------------------------------------------

describe("acceptance-setup: US-FIX-* stories excluded from fingerprint", () => {
  test("adding fix stories does NOT trigger regeneration", async () => {
    const storedFingerprint = computeACFingerprint(DEFAULT_CRITERIA);
    const ctx = makeCtx();
    const storedLayoutFingerprint = rootLayoutFingerprint(ctx);
    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: storedFingerprint,
      layoutFingerprint: storedLayoutFingerprint,
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, _input) => {
      if (op.name === "acceptance-generate") {
        generateCalled = true;
        return { testCode: "" };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    // PRD with original stories + a fix story added by acceptance loop
    const stories = [
      makeStory("US-001", ["AC-1: first criterion", "AC-2: second criterion"]),
      makeStory("US-002", ["AC-3: third criterion"]),
      makeStory("US-FIX-001", ["Fix the broken validation logic"]),
    ];
    ctx.prd = makePrd(stories);
    expect(rootLayoutFingerprint(ctx, stories.slice(0, 2))).toBe(storedLayoutFingerprint);

    await acceptanceSetupStage.execute(ctx);

    expect(generateCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P2-A: No regeneration when fingerprint matches (idempotent, AC-16)
// ---------------------------------------------------------------------------

describe("acceptance-setup: no regeneration when fingerprint unchanged (AC-16)", () => {
  test("does NOT regenerate when ACs are unchanged", async () => {
    const storedFingerprint = computeACFingerprint(DEFAULT_CRITERIA);
    const ctx = makeCtx();
    let generateCalled = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: storedFingerprint,
      layoutFingerprint: rootLayoutFingerprint(ctx),
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, _input) => {
      if (op.name === "acceptance-generate") {
        generateCalled = true;
        return { testCode: "" };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(ctx);

    expect(generateCalled).toBe(false);
  });
});

describe("acceptance-setup: package layout staleness", () => {
  test("regenerates when a story moves between existing package targets without changing ACs", async () => {
    const previousStories = [
      { ...makeStory("US-001", ["AC-1: first criterion"]), workdir: "apps/a" },
      { ...makeStory("US-002", ["AC-2: second criterion"]), workdir: "apps/a" },
      { ...makeStory("US-003", ["AC-3: third criterion"]), workdir: "apps/b" },
    ];
    const currentStories = [{ ...previousStories[0], workdir: "apps/b" }, previousStories[1], previousStories[2]];
    const ctx = makeCtx({ prd: makePrd(currentStories), story: currentStories[0], stories: currentStories });
    const previousLayout = computeAcceptanceLayoutFingerprint(ctx.workdir, [
      {
        testPath: `${ctx.workdir}/apps/a/.nax/features/test-feature/.nax-acceptance.test.ts`,
        stories: previousStories.slice(0, 2),
      },
      {
        testPath: `${ctx.workdir}/apps/b/.nax/features/test-feature/.nax-acceptance.test.ts`,
        stories: previousStories.slice(2),
      },
    ]);
    let generated = 0;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: computeACFingerprint(DEFAULT_CRITERIA),
      layoutFingerprint: previousLayout,
      storyCount: 3,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op) => {
      if (op.name === "acceptance-generate") {
        generated++;
        return { testCode: 'test("AC", () => {})' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(ctx);

    expect(generated).toBe(2);
  });

  test("regenerates once when legacy metadata lacks the layout fingerprint", async () => {
    const ctx = makeCtx();
    let generated = false;

    _acceptanceSetupDeps.fileExists = async () => true;
    _acceptanceSetupDeps.readMeta = async () => ({
      generatedAt: "2026-01-01T00:00:00Z",
      acFingerprint: computeACFingerprint(DEFAULT_CRITERIA),
      storyCount: 2,
      acCount: 3,
      generator: "nax",
    });
    _acceptanceSetupDeps.copyFile = async () => {};
    _acceptanceSetupDeps.deleteFile = async () => {};
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op) => {
      if (op.name === "acceptance-generate") {
        generated = true;
        return { testCode: 'test("AC", () => {})' };
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(ctx);

    expect(generated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P2-B: acceptance-meta.json is written after generation (AC-15)
// ---------------------------------------------------------------------------

describe("acceptance-setup: writes acceptance-meta.json (P2-B, AC-15)", () => {
  test("writes meta file after generating test (AC-15)", async () => {
    let writtenMetaPath = "";
    let writtenMeta: object | undefined;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-generate") return { testCode: 'test("AC-1", () => {})' };
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async (metaPath, meta) => {
      writtenMetaPath = metaPath;
      writtenMeta = meta;
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    await acceptanceSetupStage.execute(makeCtx());

    expect(writtenMetaPath).toContain("acceptance-meta.json");
    expect(writtenMeta).not.toBeNull();
  });

  test("meta contains correct fingerprint and counts (P2-B)", async () => {
    let writtenMeta: AcceptanceMeta | undefined;

    _acceptanceSetupDeps.fileExists = async () => false;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, input) => {
      if (op.name === "acceptance-generate") return { testCode: 'test("AC-1", () => {})' };
      if (op.name === "acceptance-refine") {
        const { criteria, storyId } = input as { criteria: string[]; storyId: string };
        return criteria.map((c: string) => ({ original: c, refined: c, testable: true, storyId }));
      }
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.writeFile = async () => {};
    _acceptanceSetupDeps.writeMeta = async (_path, meta) => {
      writtenMeta = meta;
    };
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });

    const ctx = makeCtx();
    await acceptanceSetupStage.execute(ctx);

    expect(writtenMeta).not.toBeNull();
    assertDefined(writtenMeta, "writtenMeta");
    expect(writtenMeta.acFingerprint).toBe(computeACFingerprint(DEFAULT_CRITERIA));
    expect(writtenMeta.layoutFingerprint).toBe(rootLayoutFingerprint(ctx));
    expect(writtenMeta.acCount).toBe(3);
    expect(writtenMeta.storyCount).toBe(2);
    expect(writtenMeta.generatedAt).toBeString();
    expect(writtenMeta.generator).toBe("nax");
  });
});

// ---------------------------------------------------------------------------
// Absorbed: acceptance-setup-dispatch-root.test.ts
// ---------------------------------------------------------------------------

const dispatchRootTestSel = pickSelector("acceptance-setup-dispatch-root-test", "routing");

const dispatchRootSuccessResult = {
  success: true,
  exitCode: 0,
  output: "ok",
  rateLimited: false,
  durationMs: 1,
  estimatedCostUsd: 0,
  agentFallbacks: [],
};

function makeDispatchRootRunOp(): RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> {
  return {
    kind: "run",
    name: "acceptance-setup-root-probe",
    stage: "run",
    config: dispatchRootTestSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You echo text.", overridable: false },
      task: { id: "task", content: input.text, overridable: false },
    }),
    parse: (output) => output.trim(),
  };
}

function makeDispatchRootCtx(runtime: NaxRuntime, repoRoot: string, prd: PRD): PipelineContext {
  return {
    config: runtime.configLoader.current(),
    rootConfig: runtime.configLoader.current(),
    prd,
    story: prd.userStories[0],
    stories: prd.userStories,
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: repoRoot,
    projectDir: repoRoot,
    featureDir: path.join(repoRoot, ".nax", "features", "test-feature"),
    hooks: { hooks: {} },
    ...makeDispatchContext({ runtime }),
  };
}

const tempDirs: string[] = [];

function trackedTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) cleanupTempDir(dir);
  tempDirs.length = 0;
});

describe("acceptance-setup: main-checkout dispatch root survives the containment-root move", () => {
  test("local callOp dispatches at the main-checkout repoRoot, not a worktree path", async () => {
    const repoRoot = trackedTempDir("nax-accept-root-");
    const absPackageDir = path.join(repoRoot, "packages", "core");

    let seen: AgentRunOptions | undefined;
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        seen = req.runOptions;
        return { result: dispatchRootSuccessResult, fallbacks: [], dispatchesCompleted: 1 };
      },
    });
    const runtime = makeTestRuntime({ agentManager, workdir: repoRoot });
    const prd = makePRD({
      feature: "test-feature",
      userStories: [
        dispatchRootMakeStory({ id: "US-001", workdir: "packages/core", acceptanceCriteria: ["AC-1: works"] }),
      ],
    });
    const ctx = makeDispatchRootCtx(runtime, repoRoot, prd);

    await _acceptanceSetupDeps.callOp(ctx, absPackageDir, makeDispatchRootRunOp(), { text: "hi" });

    const packageView = runtime.packages.resolve(absPackageDir);
    // The registry relativizes the absolute packageDir, so the view's own
    // packageDir is relative — exactly the shape `storyExecRoot` expects.
    expect(packageView.packageDir).toBe("packages/core");
    expect(packageView.repoRoot).toBe(repoRoot);
    expect(storyExecRoot(packageView)).toBe(repoRoot);

    expect(seen).toBeDefined();
    expect(seen?.codingToolRoot).toBe(repoRoot);
    expect(seen?.workdir).toBe(repoRoot);
    // Discriminating: the package workdir is a different, real directory, and
    // the dispatch root must not have been re-pointed at it or at a worktree.
    expect(seen?.codingToolRoot).not.toBe(absPackageDir);
    expect(seen?.codingToolRoot).not.toContain(".nax-wt");
    expect(seen?.workdir).not.toContain(".nax-wt");
  });

  test("the absolute targetTestFilePath is inside storyExecRoot(packageView)", async () => {
    const repoRoot = trackedTempDir("nax-accept-path-");
    const runtime = makeTestRuntime({ agentManager: makeMockAgentManager(), workdir: repoRoot });
    const prd = makePRD({
      feature: "test-feature",
      userStories: [
        dispatchRootMakeStory({ id: "US-001", workdir: "packages/core", acceptanceCriteria: ["AC-1: works"] }),
      ],
    });

    // `targetTestFilePath` (acceptance-setup.ts:417) is `group.testPath`
    // verbatim, so this is the real construction, not a copy of it.
    const [group] = await groupStoriesByPackage(prd, repoRoot, "test-feature");
    expect(group).toBeDefined();
    const testPath = group?.testPath as string;
    const packageDir = group?.packageDir as string;

    expect(path.isAbsolute(packageDir)).toBe(true);
    expect(path.isAbsolute(testPath)).toBe(true);

    const packageView = runtime.packages.resolve(packageDir);
    const execRoot = storyExecRoot(packageView);
    expect(execRoot).toBe(repoRoot);

    const relativeToExecRoot = path.relative(execRoot, testPath);
    expect(path.isAbsolute(relativeToExecRoot)).toBe(false);
    expect(relativeToExecRoot.startsWith("..")).toBe(false);
    expect(testPath).not.toContain(".nax-wt");
    // Explicit reachability for a package acceptance session: the file lives
    // under the package, which lives under the main-checkout exec root.
    expect(relativeToExecRoot.startsWith(`packages/core${path.sep}`)).toBe(true);
  });
});
