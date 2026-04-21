/**
 * Unit tests for planDecomposeCommand mapper wiring (US-003 AC-5)
 *
 * Verifies that planDecomposeCommand() uses mapDecomposedStoriesToUserStories()
 * to convert adapter.decompose() output (DecomposedStory[]) to UserStory[] before
 * inserting into the PRD.
 *
 * Split from plan-decompose.test.ts which already exceeds 400 lines.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planDecomposeCommand } from "../../../src/cli/plan";
import type { DecomposedStory } from "../../../src/agents/shared/types-extended";
import { makeTempDir } from "../../helpers/temp";
import { makeMockAgentManager, makeNaxConfig, makePRD, makeStory } from "../../helpers";

function makeMockDecomposeManager(
  decomposeFn?: (agentName: string, opts: any) => Promise<{ stories: DecomposedStory[] }>,
) {
  return makeMockAgentManager({
    decomposeAsFn: decomposeFn
      ? async (name: string, opts: any) => decomposeFn(name, opts)
      : undefined,
    getAgentFn: () => ({ decompose: async () => ({ stories: [] }) } as any),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "test-feature";

function makeParentStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Parent story to decompose",
    description: "A complex story needing decomposition",
    acceptanceCriteria: ["AC-1", "AC-2", "AC-3"],
    tags: ["feature"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/index.ts"],
    routing: {
      complexity: "complex",
      testStrategy: "test-after",
      reasoning: "Too complex for one story",
    },
    ...overrides,
  };
}

function makePrd(stories: UserStory[] = [makeParentStory()]): PRD {
  return makePRD({ feature: FEATURE, branchName: "feat/test-feature", userStories: stories });
}

function makeDecomposedStory(overrides: Partial<DecomposedStory> = {}): DecomposedStory {
  return {
    id: "US-001-A",
    title: "Sub-story A",
    description: "First sub-story",
    acceptanceCriteria: ["AC-1"],
    tags: ["feature"],
    dependencies: [],
    complexity: "simple",
    contextFiles: ["src/feature-a.ts"],
    reasoning: "Simple isolated task",
    estimatedLOC: 30,
    risks: [],
    testStrategy: "test-after",
    ...overrides,
  };
}

function makeFakeScan() {
  return {
    fileTree: "└── src/\n    └── index.ts",
    dependencies: {},
    devDependencies: {},
    testPatterns: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save originals
// ─────────────────────────────────────────────────────────────────────────────

const origExistsSync = _planDeps.existsSync;
const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanCodebase = _planDeps.scanCodebase;
const origCreateManager = _planDeps.createManager;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;
const origReadPackageJson = _planDeps.readPackageJson;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;

// ─────────────────────────────────────────────────────────────────────────────
// Tests: planDecomposeCommand uses mapper (AC-5)
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — mapper wiring (US-003 AC-5)", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;

  function setupDepsWithDecompose(
    prd: PRD,
    decomposedStories: DecomposedStory[],
  ) {
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");

    _planDeps.existsSync = mock((path: string) => path === prdPath);
    _planDeps.readFile = mock(async (path: string) => {
      if (path === prdPath) return JSON.stringify(prd);
      return "";
    });
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWriteArgs.push([path, content]);
    });
    _planDeps.scanCodebase = mock(async () => makeFakeScan());
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => null);
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createManager = mock(() =>
      makeMockDecomposeManager(async (_name: string, _opts: any) => ({
        stories: decomposedStories,
      })),
    );
  }

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-mapper-test-");
    capturedWriteArgs = [];
    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    _planDeps.existsSync = origExistsSync;
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
    _planDeps.createManager = origCreateManager;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("sub-stories written to PRD have status pending from mapper", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A" }),
      makeDecomposedStory({ id: "US-001-B", complexity: "medium" }),
    ];
    setupDepsWithDecompose(prd, decomposed);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStories = written.userStories.filter((s) => s.parentStoryId === "US-001");
    expect(subStories).toHaveLength(2);
    for (const s of subStories) {
      expect(s.status).toBe("pending");
    }
  });

  test("sub-stories written to PRD have passes false from mapper", async () => {
    const prd = makePrd();
    setupDepsWithDecompose(prd, [makeDecomposedStory({ id: "US-001-A" })]);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStories = written.userStories.filter((s) => s.parentStoryId === "US-001");
    for (const s of subStories) {
      expect(s.passes).toBe(false);
    }
  });

  test("sub-stories written to PRD have escalations empty array from mapper", async () => {
    const prd = makePrd();
    setupDepsWithDecompose(prd, [makeDecomposedStory({ id: "US-001-A" })]);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStories = written.userStories.filter((s) => s.parentStoryId === "US-001");
    for (const s of subStories) {
      expect(s.escalations).toEqual([]);
    }
  });

  test("sub-stories written to PRD have attempts 0 from mapper", async () => {
    const prd = makePrd();
    setupDepsWithDecompose(prd, [makeDecomposedStory({ id: "US-001-A" })]);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStories = written.userStories.filter((s) => s.parentStoryId === "US-001");
    for (const s of subStories) {
      expect(s.attempts).toBe(0);
    }
  });

  test("routing.complexity in written PRD matches DecomposedStory.complexity", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A", complexity: "simple" }),
      makeDecomposedStory({ id: "US-001-B", complexity: "expert" }),
    ];
    setupDepsWithDecompose(prd, decomposed);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const storyA = written.userStories.find((s) => s.id === "US-001-A");
    const storyB = written.userStories.find((s) => s.id === "US-001-B");
    expect(storyA?.routing?.complexity).toBe("simple");
    expect(storyB?.routing?.complexity).toBe("expert");
  });

  test("routing.testStrategy in written PRD matches DecomposedStory.testStrategy", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A", testStrategy: "tdd-simple" }),
      makeDecomposedStory({ id: "US-001-B", testStrategy: "three-session-tdd" }),
    ];
    setupDepsWithDecompose(prd, decomposed);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const storyA = written.userStories.find((s) => s.id === "US-001-A");
    const storyB = written.userStories.find((s) => s.id === "US-001-B");
    expect(storyA?.routing?.testStrategy).toBe("tdd-simple");
    expect(storyB?.routing?.testStrategy).toBe("three-session-tdd");
  });

  test("throws DECOMPOSE_VALIDATION_FAILED with entry index when DecomposedStory has empty id", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A" }),
      makeDecomposedStory({ id: "" }), // invalid — empty id
    ];
    setupDepsWithDecompose(prd, decomposed);

    let caught: unknown;
    try {
      await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
    // biome-ignore lint: test accesses dynamic property
    expect((caught as any)?.context?.entryIndex).toBeDefined();
  });

  test("throws DECOMPOSE_VALIDATION_FAILED with entry index when DecomposedStory has empty contextFiles", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A", contextFiles: [] }), // invalid — empty contextFiles
    ];
    setupDepsWithDecompose(prd, decomposed);

    let caught: unknown;
    try {
      await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
    // biome-ignore lint: test accesses dynamic property
    expect((caught as any)?.context?.entryIndex).toBeDefined();
  });
});
