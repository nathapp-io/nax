/**
 * Unit tests for planDecomposeCommand — validation guards (AC-1 through AC-8)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planDecomposeCommand } from "../../../src/cli/plan";
import { buildDecomposePromptAsync } from "../../../src/agents/shared/decompose-prompt";
import type { DecomposeOptions, DecomposedStory } from "../../../src/agents/shared/types-extended";
import { NaxError } from "../../../src/errors";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";
import { makeMockAgentManager, makeNaxConfig, makePRD, makeStory } from "../../helpers";

function makeMockDecomposeManager(
  decomposeFn?: (agentName: string, opts: DecomposeOptions) => Promise<{ stories: DecomposedStory[] }>,
) {
  return makeMockAgentManager({
    decomposeAsFn: decomposeFn
      ? async (name: string, opts: DecomposeOptions) => decomposeFn(name, opts)
      : undefined,
    getAgentFn: () => ({ decompose: async () => ({ stories: [] }) } as any),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "my-feature";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Original story",
    description: "Description of the story",
    acceptanceCriteria: ["AC-1: Does something", "AC-2: Does another thing"],
    tags: ["feature"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/foo.ts"],
    routing: {
      complexity: "medium",
      testStrategy: "test-after",
      reasoning: "medium complexity",
      modelTier: "balanced",
    },
    ...overrides,
  };
}

function makeSiblingStory(id: string, title: string): UserStory {
  return makeStory({ id, title });
}

function makePrd(stories: UserStory[] = [makeStory()]): PRD {
  return makePRD({ feature: FEATURE, branchName: "feat/my-feature", userStories: stories });
}

function makeSubStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return makeStory({ id, title: `Sub-story ${id}`, description: `Description for ${id}`, contextFiles: ["src/foo.ts"], routing: { complexity: "simple", testStrategy: "test-after", reasoning: "simple", modelTier: "balanced" }, ...overrides });
}

function toDecomposedStory(story: UserStory): DecomposedStory {
  return {
    id: story.id,
    title: story.title,
    description: story.description,
    acceptanceCriteria: story.acceptanceCriteria,
    tags: story.tags,
    dependencies: story.dependencies,
    complexity: story.routing?.complexity ?? "simple",
    contextFiles: story.contextFiles ?? [],
    reasoning: story.routing?.reasoning ?? "",
    estimatedLOC: 50,
    risks: [],
    testStrategy: story.routing?.testStrategy,
  };
}

function makeDecomposeResponse(stories: UserStory[]): string {
  return JSON.stringify(stories.map(toDecomposedStory));
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return makeNaxConfig({
    precheck: {
      storySizeGate: {
        enabled: true,
        maxAcCount: 6,
        maxDescriptionLength: 3000,
        maxBulletPoints: 12,
        action: "block",
        maxReplanAttempts: 3,
      },
    },
    agent: { default: "claude" },
    ...overrides,
  });
}

function makeFakeScan() {
  return {
    fileTree: "└── src/\n    └── index.ts",
    dependencies: { zod: "^3.0.0" },
    devDependencies: {},
    testPatterns: [],
  };
}

const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanCodebase = _planDeps.scanCodebase;
const origCreateManager = _planDeps.createManager;
const origExistsSync = _planDeps.existsSync;
const origCreateDebateSession = _planDeps.createDebateSession;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;
const origReadPackageJson = _planDeps.readPackageJson;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;

describe("planDecomposeCommand — guards (AC-1 to AC-8)", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;
  let capturedCompleteArgs: string[];

  function setupDeps(
    prd: PRD,
    stories: UserStory[] = [makeSubStory("US-001-A"), makeSubStory("US-001-B")],
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
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createManager = mock(() =>
      makeMockDecomposeManager(async (_name: string, options: DecomposeOptions) => {
        capturedCompleteArgs.push(await buildDecomposePromptAsync(options));
        return { stories: stories.map(toDecomposedStory) };
      }),
    );
  }

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-test-");
    capturedWriteArgs = [];
    capturedCompleteArgs = [];
    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
    _planDeps.createManager = origCreateManager;
    _planDeps.existsSync = origExistsSync;
    _planDeps.createDebateSession = origCreateDebateSession;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    cleanupTempDir(tmpDir);
  });

  test("AC-1: planDecomposeCommand is exported as a function", () => {
    expect(typeof planDecomposeCommand).toBe("function");
  });

  test("AC-1: planDecomposeCommand returns a Promise", async () => {
    const prd = makePrd();
    setupDeps(prd);
    const result = planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });
    expect(result).toBeInstanceOf(Promise);
    await result.catch(() => {});
  });

  test("AC-2: throws NaxError with code PRD_NOT_FOUND when prd.json does not exist", async () => {
    _planDeps.existsSync = mock(() => false);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "PRD_NOT_FOUND" });
  });

  test("AC-2: error thrown is a NaxError instance", async () => {
    _planDeps.existsSync = mock(() => false);
    let caught: unknown;
    try {
      await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
  });

  test("AC-3: throws NaxError with code STORY_NOT_FOUND when storyId not in PRD", async () => {
    const prd = makePrd([makeStory({ id: "US-001" })]);
    setupDeps(prd);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-999" }),
    ).rejects.toMatchObject({ code: "STORY_NOT_FOUND" });
  });

  test("AC-4: throws NaxError with code STORY_ALREADY_DECOMPOSED when story is already decomposed", async () => {
    const prd = makePrd([makeStory({ id: "US-001", status: "decomposed" })]);
    setupDeps(prd);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "STORY_ALREADY_DECOMPOSED" });
  });

  test("AC-5: prompt includes full target story JSON with ID and title", async () => {
    const targetStory = makeStory({ id: "US-001", title: "My unique target story" });
    const prd = makePrd([targetStory, makeSiblingStory("US-002", "A sibling story")]);
    setupDeps(prd);
    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });
    const prompt = capturedCompleteArgs[0];
    expect(prompt).toContain("US-001");
    expect(prompt).toContain("My unique target story");
  });

  test("AC-5: prompt includes sibling story IDs and titles", async () => {
    const prd = makePrd([
      makeStory({ id: "US-001" }),
      makeSiblingStory("US-002", "First sibling"),
      makeSiblingStory("US-003", "Second sibling"),
    ]);
    setupDeps(prd);
    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });
    const prompt = capturedCompleteArgs[0];
    expect(prompt).toContain("US-002");
    expect(prompt).toContain("First sibling");
    expect(prompt).toContain("US-003");
    expect(prompt).toContain("Second sibling");
  });

  test("AC-5: prompt includes codebase context from buildCodebaseContext", async () => {
    const prd = makePrd();
    setupDeps(prd);
    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });
    const prompt = capturedCompleteArgs[0];
    expect(prompt).toContain("Codebase");
    expect(prompt).toContain("zod");
  });

  test("AC-5: adapter.decompose() receives decompose context options", async () => {
    const prd = makePrd();
    const capturedDecomposeOpts: unknown[] = [];
    _planDeps.existsSync = mock((path: string) =>
      path === join(tmpDir, ".nax", "features", FEATURE, "prd.json"),
    );
    _planDeps.readFile = mock(async () => JSON.stringify(prd));
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
      makeMockDecomposeManager(async (_name: string, opts: unknown) => {
        capturedDecomposeOpts.push(opts);
        return { stories: [makeSubStory("US-001-A"), makeSubStory("US-001-B")].map(toDecomposedStory) };
      }),
    );
    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });
    expect(capturedDecomposeOpts[0]).toMatchObject({ workdir: tmpDir, featureName: FEATURE, storyId: "US-001" });
  });

  test("AC-6: throws DECOMPOSE_VALIDATION_FAILED when sub-story has empty contextFiles array", async () => {
    const prd = makePrd();
    setupDeps(prd, [makeSubStory("US-001-A", { contextFiles: [] }), makeSubStory("US-001-B")]);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
  });

  test("AC-6: throws DECOMPOSE_VALIDATION_FAILED when sub-story has no contextFiles field", async () => {
    const prd = makePrd();
    const noCtxStory = makeSubStory("US-001-A");
    delete (noCtxStory as Partial<UserStory>).contextFiles;
    setupDeps(prd, [noCtxStory, makeSubStory("US-001-B")]);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
  });

  test("AC-7: missing routing.complexity in legacy input is tolerated (adapter coercion)", async () => {
    const prd = makePrd();
    const badStory = makeSubStory("US-001-A");
    if (badStory.routing) delete (badStory.routing as Partial<typeof badStory.routing>).complexity;
    setupDeps(prd, [badStory]);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).resolves.not.toThrow();
  });

  test("AC-7: throws DECOMPOSE_VALIDATION_FAILED when sub-story missing routing.testStrategy", async () => {
    const prd = makePrd();
    const badStory = makeSubStory("US-001-A");
    if (badStory.routing) delete (badStory.routing as Partial<typeof badStory.routing>).testStrategy;
    setupDeps(prd, [badStory]);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
  });

  test("AC-7: missing routing.modelTier in legacy input is tolerated (mapper default)", async () => {
    const prd = makePrd();
    const badStory = makeSubStory("US-001-A");
    if (badStory.routing) delete (badStory.routing as Partial<typeof badStory.routing>).modelTier;
    setupDeps(prd, [badStory]);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).resolves.not.toThrow();
  });

  test("AC-7: throws DECOMPOSE_VALIDATION_FAILED when sub-story has no routing field", async () => {
    const prd = makePrd();
    const badStory = makeSubStory("US-001-A");
    delete (badStory as Partial<UserStory>).routing;
    setupDeps(prd, [badStory]);
    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
  });

  test("AC-8: throws DECOMPOSE_VALIDATION_FAILED when sub-story exceeds maxAcCount", async () => {
    const config = makeConfig();
    const tooManyAcs = Array.from({ length: 7 }, (_, i) => `AC-${i + 1}: criterion`);
    const prd = makePrd();
    setupDeps(prd, [makeSubStory("US-001-A", { acceptanceCriteria: tooManyAcs })]);
    await expect(
      planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
  });

  test("AC-8: accepts sub-story with exactly maxAcCount acceptance criteria", async () => {
    const config = makeConfig();
    const exactAcs = Array.from({ length: 6 }, (_, i) => `AC-${i + 1}: criterion`);
    const prd = makePrd();
    setupDeps(prd, [makeSubStory("US-001-A", { acceptanceCriteria: exactAcs }), makeSubStory("US-001-B")]);
    await expect(
      planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" }),
    ).resolves.not.toThrow();
  });
});
