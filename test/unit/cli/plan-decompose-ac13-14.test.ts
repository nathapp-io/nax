/**
 * Unit tests for planDecomposeCommand (US-002)
 *
 * Covers: debate session fallback to adapter.decompose() on failure,
 * and no-debate path (AC-13, AC-14).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planDecomposeCommand } from "../../../src/cli/plan";
import { buildDecomposePromptAsync } from "../../../src/agents/shared/decompose-prompt";
import type { DecomposeOptions, DecomposedStory } from "../../../src/agents/shared/types-extended";
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

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return { ...makeNaxConfig(), ...overrides };
}

function makeFakeScan() {
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
const origScanCodebase = _planDeps.scanCodebase;
const origCreateManager = _planDeps.createManager;
const origExistsSync = _planDeps.existsSync;
const origCreateDebateSession = _planDeps.createDebateSession;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;
const origReadPackageJson = _planDeps.readPackageJson;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — debate fallback and no-debate path", () => {
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

    const fakeAdapter = {
      decompose: mock(async (options: DecomposeOptions) => {
        capturedCompleteArgs.push(await buildDecomposePromptAsync(options));
        return { stories: stories.map(toDecomposedStory) };
      }),
    };
    _planDeps.createManager = mock(() =>
      makeMockDecomposeManager(async (_name: string, opts: any) => fakeAdapter.decompose(opts)),
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

  // ──────────────────────────────────────────────────────────────────────────
  // AC-13: debate outcome === 'failed' falls back to adapter.decompose()
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-13: falls back to adapter.decompose() when debate outcome is 'failed'", async () => {
    const stories = [makeSubStory("US-001-A"), makeSubStory("US-001-B")];
    const prd = makePrd();
    setupDeps(prd, stories);

    _planDeps.createDebateSession = mock(() => ({
      run: mock(async () => ({
        storyId: "US-001",
        stage: "decompose",
        outcome: "failed" as const,
        rounds: 0,
        debaters: [],
        resolverType: "synthesis" as const,
        proposals: [],
        totalCostUsd: 0,
      })),
    }) as never);

    const adapterDecomposeCalls: unknown[] = [];
    _planDeps.createManager = mock(() =>
      makeMockDecomposeManager(async (_name: string, opts: unknown) => {
        adapterDecomposeCalls.push(opts);
        return { stories: stories.map(toDecomposedStory) };
      }),
    );

    const debateConfig = {
      enabled: true,
      agents: 2,
      stages: {
        decompose: {
          enabled: true,
          resolver: { type: "synthesis" as const },
          sessionMode: "one-shot" as const,
          rounds: 1,
        },
      },
    };

    await planDecomposeCommand(
      tmpDir,
      makeConfig({ debate: debateConfig as never }),
      { feature: FEATURE, storyId: "US-001" },
    );

    expect(adapterDecomposeCalls).toHaveLength(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-14: no debate config → adapter.decompose() called directly
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-14: calls adapter.decompose() directly when debate.stages.decompose is not configured", async () => {
    const prd = makePrd();
    const adapterDecomposeCalls: unknown[] = [];

    setupDeps(prd);
    _planDeps.createManager = mock(() =>
      makeMockDecomposeManager(async (_name: string, opts: unknown) => {
        adapterDecomposeCalls.push(opts);
        return { stories: [makeSubStory("US-001-A"), makeSubStory("US-001-B")].map(toDecomposedStory) };
      }),
    );

    const createDebateCalled: boolean[] = [];
    _planDeps.createDebateSession = mock(() => {
      createDebateCalled.push(true);
      return {} as never;
    });

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    expect(adapterDecomposeCalls).toHaveLength(1);
    expect(createDebateCalled).toHaveLength(0);
  });

  test("AC-14: does not create DebateSession when debate.enabled is false", async () => {
    const prd = makePrd();
    setupDeps(prd);

    const createDebateCalled: boolean[] = [];
    _planDeps.createDebateSession = mock(() => {
      createDebateCalled.push(true);
      return {} as never;
    });

    await planDecomposeCommand(
      tmpDir,
      makeConfig({ debate: { enabled: false, agents: 2, stages: {} as never } as any }),
      { feature: FEATURE, storyId: "US-001" },
    );

    expect(createDebateCalled).toHaveLength(0);
  });

  test("AC-14: does not create DebateSession when debate config is absent", async () => {
    const prd = makePrd();
    setupDeps(prd);

    const createDebateCalled: boolean[] = [];
    _planDeps.createDebateSession = mock(() => {
      createDebateCalled.push(true);
      return {} as never;
    });

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    expect(createDebateCalled).toHaveLength(0);
  });
});
