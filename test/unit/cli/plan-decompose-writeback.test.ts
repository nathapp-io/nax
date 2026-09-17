/**
 * Unit tests for planDecomposeCommand (US-002)
 *
 * Covers: PRD write-back — original story status='decomposed',
 * sub-story parentStoryId, and path/content verification (AC-9, AC-10).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeDebateRunner,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { DecomposedStory } from "@/agents/shared/types-extended";
import type { CompleteOptions } from "@/agents/types";
import { _planDeps, planDecomposeCommand } from "@/cli/plan";
import { _persistPrdDeps } from "@/plan/strategies";
import type { PRD, UserStory } from "@/prd";
import { getContextFiles } from "@/prd";

function makeMockDecomposeManager(
  decomposeFn?: (agentName: string, opts: CompleteOptions) => Promise<{ stories: DecomposedStory[] }>,
) {
  return makeMockAgentManager({
    completeAsFn: decomposeFn
      ? async (name: string, _prompt: string, opts?: CompleteOptions) => {
          assertDefined(opts, "completeAs opts");
          const result = await decomposeFn(name, opts);
          return {
            output: JSON.stringify(result.stories),
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
            estimatedCostUsd: 0,
          };
        }
      : async () => ({
          output: JSON.stringify([]),
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
        }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "my-feature";

function makeStageConfig() {
  return {
    enabled: false,
    resolver: { type: "synthesis" as const },
    sessionMode: "one-shot" as const,
    rounds: 0,
  };
}

function makeSiblingStory(id: string, title: string): UserStory {
  return makeStory({ id, title });
}

function makePrd(stories: UserStory[] = [makeStory()]): PRD {
  return makePRD({ feature: FEATURE, branchName: "feat/my-feature", userStories: stories });
}

function makeSubStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    ...makeStory({
      id,
      title: `Sub-story ${id}`,
      description: `Description for ${id}`,
      contextFiles: ["src/foo.ts"],
      routing: { complexity: "simple", testStrategy: "test-after", reasoning: "simple", modelTier: "balanced" },
    }),
    acceptanceCriteria: ["AC-1: Does something"],
    tags: ["feature"],
    ...overrides,
  };
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
    contextFiles: getContextFiles(story),
    reasoning: story.routing?.reasoning ?? "",
    estimatedLOC: 50,
    risks: [],
    testStrategy: story.routing?.testStrategy,
  };
}

function makeDecomposeResponse(stories: UserStory[]): string {
  return JSON.stringify(stories.map(toDecomposedStory));
}

function _makeFakeScan() {
  return {
    fileTree: "└── src/\n    └── index.ts",
    dependencies: { zod: "^3.0.0" },
    devDependencies: {},
    testPatterns: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for afterEach restoration
// ─────────────────────────────────────────────────────────────────────────────

const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanSourceRoots = _planDeps.scanSourceRoots;
const origCreateRuntime = _planDeps.createRuntime;
const origExistsSync = _planDeps.existsSync;
const origCreateDebateRunner = _planDeps.createDebateRunner;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;
const origReadPackageJson = _planDeps.readPackageJson;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — PRD write-back", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;

  function setupDeps(prd: PRD, stories: UserStory[] = [makeSubStory("US-001-A"), makeSubStory("US-001-B")]) {
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");

    _planDeps.existsSync = mock((path: string) => path === prdPath);

    _planDeps.readFile = mock(async (path: string) => {
      if (path === prdPath) return JSON.stringify(prd);
      return "";
    });

    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWriteArgs.push([path, content]);
    });

    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});

    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockDecomposeManager(async () => ({
          stories: stories.map(toDecomposedStory),
        })),
      }),
    );
  }

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-test-");
    capturedWriteArgs = [];
    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.existsSync = origExistsSync;
    _planDeps.createDebateRunner = origCreateDebateRunner;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    cleanupTempDir(tmpDir);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-9: original story gets status 'decomposed', sub-stories get parentStoryId
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-9: original story has status 'decomposed' in written PRD", async () => {
    const prd = makePrd([makeStory({ id: "US-001" })]);
    setupDeps(prd);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const original = written.userStories.find((s) => s.id === "US-001");
    expect(original?.status).toBe("decomposed");
  });

  test("AC-9: each sub-story has parentStoryId set to original story ID", async () => {
    const prd = makePrd([makeStory({ id: "US-001" })]);
    const stories = [makeSubStory("US-001-A"), makeSubStory("US-001-B")];
    setupDeps(prd, stories);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subA = written.userStories.find((s) => s.id === "US-001-A");
    const subB = written.userStories.find((s) => s.id === "US-001-B");
    expect(subA?.parentStoryId).toBe("US-001");
    expect(subB?.parentStoryId).toBe("US-001");
  });

  test("AC-9: written PRD contains both the original story and all sub-stories", async () => {
    const prd = makePrd([makeStory({ id: "US-001" }), makeSiblingStory("US-002", "Sibling")]);
    setupDeps(prd, [makeSubStory("US-001-A"), makeSubStory("US-001-B")]);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const ids = written.userStories.map((s) => s.id);
    expect(ids).toContain("US-001");
    expect(ids).toContain("US-001-A");
    expect(ids).toContain("US-001-B");
    expect(ids).toContain("US-002");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-10: writes updated PRD to .nax/features/<feature>/prd.json
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-10: writes updated PRD to correct path", async () => {
    const prd = makePrd();
    setupDeps(prd);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const expectedPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");
    expect(capturedWriteArgs.length).toBeGreaterThan(0);
    expect(capturedWriteArgs[0][0]).toBe(expectedPath);
  });

  test("AC-10: written content is valid JSON with PRD structure", async () => {
    const prd = makePrd();
    setupDeps(prd);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const content = capturedWriteArgs[0][1];
    expect(() => JSON.parse(content)).not.toThrow();
    const written = JSON.parse(content) as PRD;
    expect(Array.isArray(written.userStories)).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-12: debate enabled — creates DebateSession with stage 'decompose'
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-12: creates DebateSession with stage 'decompose' when debate is enabled", async () => {
    const stories = [makeSubStory("US-001-A"), makeSubStory("US-001-B")];
    const prd = makePrd();
    setupDeps(prd, stories);

    const capturedDebateOpts: unknown[] = [];
    _planDeps.createDebateRunner = mock((opts) => {
      capturedDebateOpts.push(opts);
      return makeDebateRunner({
        run: mock(async () => ({
          storyId: "US-001",
          stage: "decompose",
          outcome: "passed" as const,
          rounds: 1,
          debaters: ["claude"],
          resolverType: "synthesis" as const,
          proposals: [],
          totalCostUsd: 0,
          output: makeDecomposeResponse(stories),
        })),
      });
    });

    const debateConfig = {
      enabled: true,
      agents: 2,
      stages: {
        plan: makeStageConfig(),
        review: makeStageConfig(),
        acceptance: makeStageConfig(),
        rectification: makeStageConfig(),
        escalation: makeStageConfig(),
        decompose: {
          enabled: true,
          resolver: { type: "synthesis" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
        },
      },
    };

    await planDecomposeCommand(tmpDir, makeNaxConfig({ debate: debateConfig }), {
      feature: FEATURE,
      storyId: "US-001",
    });

    expect(_planDeps.createDebateRunner).toHaveBeenCalledTimes(1);
    expect(capturedDebateOpts[0]).toMatchObject({ stage: "decompose" });
  });

  test("AC-12: uses debate output when outcome is not 'failed'", async () => {
    const stories = [makeSubStory("US-001-A"), makeSubStory("US-001-B")];
    const prd = makePrd();
    setupDeps(prd, stories);

    _planDeps.createDebateRunner = mock(() =>
      makeDebateRunner({
        run: mock(async () => ({
          storyId: "US-001",
          stage: "decompose",
          outcome: "passed" as const,
          rounds: 1,
          debaters: ["claude"],
          resolverType: "synthesis" as const,
          proposals: [],
          totalCostUsd: 0,
          output: makeDecomposeResponse(stories),
        })),
      }),
    );

    const adapterDecomposeCalls: unknown[] = [];
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockDecomposeManager(async (_name: string, opts: unknown) => {
          adapterDecomposeCalls.push(opts);
          return { stories: stories.map(toDecomposedStory) };
        }),
      }),
    );

    const debateConfig = {
      enabled: true,
      agents: 2,
      stages: {
        plan: makeStageConfig(),
        review: makeStageConfig(),
        acceptance: makeStageConfig(),
        rectification: makeStageConfig(),
        escalation: makeStageConfig(),
        decompose: {
          enabled: true,
          resolver: { type: "synthesis" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
        },
      },
    };

    await planDecomposeCommand(tmpDir, makeNaxConfig({ debate: debateConfig }), {
      feature: FEATURE,
      storyId: "US-001",
    });

    // When debate succeeds, adapter.decompose() should NOT be called
    expect(adapterDecomposeCalls).toHaveLength(0);
  });
});

describe("planDecomposeCommand — writes through the plan-write seam (nax#2080)", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;
  let origPersistExistsSync: typeof _persistPrdDeps.existsSync;
  let origPersistDiscover: typeof _persistPrdDeps.discoverWorkspacePackages;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-seam-");
    capturedWriteArgs = [];
    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });
    origPersistExistsSync = _persistPrdDeps.existsSync;
    origPersistDiscover = _persistPrdDeps.discoverWorkspacePackages;
  });

  afterEach(() => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.existsSync = origExistsSync;
    _planDeps.createDebateRunner = origCreateDebateRunner;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _persistPrdDeps.existsSync = origPersistExistsSync;
    _persistPrdDeps.discoverWorkspacePackages = origPersistDiscover;
    cleanupTempDir(tmpDir);
  });

  function setup(prd: PRD, stories: UserStory[]) {
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");
    _planDeps.existsSync = mock((path: string) => path === prdPath);
    _planDeps.readFile = mock(async (path: string) => (path === prdPath ? JSON.stringify(prd) : ""));
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWriteArgs.push([path, content]);
    });
    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockDecomposeManager(async () => ({ stories: stories.map(toDecomposedStory) })),
      }),
    );
    return prdPath;
  }

  test("stamps workdirSource and repo-frames the sub-story's contextFiles", async () => {
    const parent = makeStory({ id: "US-001", workdir: "packages/app", workdirSource: "stated" });
    setup(makePrd([parent]), [makeSubStory("US-001-A", { contextFiles: ["src/foo.ts"] })]);

    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = (p: string) => p === join(tmpDir, "packages/app/src/foo.ts");

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const sub = written.userStories.find((s) => s.id === "US-001-A");
    assertDefined(sub, "sub-story US-001-A");
    expect(sub.workdir).toBe("packages/app");
    expect(sub.workdirSource).toBe("stated");
    expect(getContextFiles(sub)).toEqual(["packages/app/src/foo.ts"]);
  });

  /**
   * `makeNaxConfig()` ships `routing.agents = { enabled: true, strategy: "off", profiles: [] }`,
   * and `resolveAgentAssignment` returns null on an empty `profiles` list
   * (src/agents/shared/agent-profile-resolver.ts:25-26). Under that default the
   * "sibling keeps its agent" assertion below would hold with or without the scope
   * guard. A real profile is what makes it a test.
   */
  function makeRoutedConfig() {
    return makeNaxConfig({
      routing: {
        agents: {
          enabled: true,
          strategy: "off",
          default: "claude-default",
          profiles: [{ id: "claude-default", target: { agent: "claude", model: "balanced" }, strengths: ["design"] }],
        },
      },
    });
  }

  test("leaves an already-executed sibling untouched", async () => {
    const parent = makeStory({ id: "US-001" });
    const done = makeStory({
      id: "US-002",
      status: "passed",
      contextFiles: ["src/bar.ts"],
      routing: { complexity: "medium", testStrategy: "tdd-simple", reasoning: "r", agent: "opencode" },
    });
    setup(makePrd([parent, done]), [makeSubStory("US-001-A")]);

    // A probe that would happily re-frame and re-derive everything if it were asked.
    _persistPrdDeps.discoverWorkspacePackages = async () => ["packages/app"];
    _persistPrdDeps.existsSync = () => true;

    await planDecomposeCommand(tmpDir, makeRoutedConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const sibling = written.userStories.find((s) => s.id === "US-002");
    assertDefined(sibling, "sibling US-002");
    expect(sibling.status).toBe("passed");
    expect(sibling.workdirSource).toBeUndefined();
    expect(sibling.workdir).toBeUndefined();
    expect(getContextFiles(sibling)).toEqual(["src/bar.ts"]);
    expect(sibling.routing?.agent).toBe("opencode");

    // Positive control: the new sub-story IS resolved by the seam, so the sibling
    // assertion above is about the scope rather than about routing being inert.
    const sub = written.userStories.find((s) => s.id === "US-001-A");
    expect(sub?.routing?.agent).toBe("claude");
  });

  test("preserves the PRD project field and still stamps routingProfile", async () => {
    setup(makePrd([makeStory({ id: "US-001" })]), [makeSubStory("US-001-A")]);
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = () => false;

    const before = makePrd([makeStory({ id: "US-001" })]);
    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    expect(written.project).toBe(before.project);
    expect(written.routingProfile).toBe("default");
  });
});
