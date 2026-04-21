/**
 * Unit tests for planDecomposeCommand (US-002)
 *
 * Covers: PRD write-back — original story status='decomposed',
 * sub-story parentStoryId, and path/content verification (AC-9, AC-10).
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

function makeSiblingStory(id: string, title: string): UserStory {
  return makeStory({ id, title });
}

function makePrd(stories: UserStory[] = [makeStory()]): PRD {
  return makePRD({ feature: FEATURE, branchName: "feat/my-feature", userStories: stories });
}

function makeSubStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    ...makeStory({ id, title: `Sub-story ${id}`, description: `Description for ${id}`, contextFiles: ["src/foo.ts"], routing: { complexity: "simple", testStrategy: "test-after", reasoning: "simple", modelTier: "balanced" } }),
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

describe("planDecomposeCommand — PRD write-back", () => {
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

  // ──────────────────────────────────────────────────────────────────────────
  // AC-9: original story gets status 'decomposed', sub-stories get parentStoryId
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-9: original story has status 'decomposed' in written PRD", async () => {
    const prd = makePrd([makeStory({ id: "US-001" })]);
    setupDeps(prd);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const original = written.userStories.find((s) => s.id === "US-001");
    expect(original?.status).toBe("decomposed");
  });

  test("AC-9: each sub-story has parentStoryId set to original story ID", async () => {
    const prd = makePrd([makeStory({ id: "US-001" })]);
    const stories = [makeSubStory("US-001-A"), makeSubStory("US-001-B")];
    setupDeps(prd, stories);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subA = written.userStories.find((s) => s.id === "US-001-A");
    const subB = written.userStories.find((s) => s.id === "US-001-B");
    expect(subA?.parentStoryId).toBe("US-001");
    expect(subB?.parentStoryId).toBe("US-001");
  });

  test("AC-9: written PRD contains both the original story and all sub-stories", async () => {
    const prd = makePrd([makeStory({ id: "US-001" }), makeSiblingStory("US-002", "Sibling")]);
    setupDeps(prd, [makeSubStory("US-001-A"), makeSubStory("US-001-B")]);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

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

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    const expectedPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");
    expect(capturedWriteArgs.length).toBeGreaterThan(0);
    expect(capturedWriteArgs[0][0]).toBe(expectedPath);
  });

  test("AC-10: written content is valid JSON with PRD structure", async () => {
    const prd = makePrd();
    setupDeps(prd);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

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
    _planDeps.createDebateSession = mock((opts) => {
      capturedDebateOpts.push(opts);
      return {
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
      } as never;
    });

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

    expect(_planDeps.createDebateSession).toHaveBeenCalledTimes(1);
    expect(capturedDebateOpts[0]).toMatchObject({ stage: "decompose" });
  });

  test("AC-12: uses debate output when outcome is not 'failed'", async () => {
    const stories = [makeSubStory("US-001-A"), makeSubStory("US-001-B")];
    const prd = makePrd();
    setupDeps(prd, stories);

    _planDeps.createDebateSession = mock(() => ({
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

    // When debate succeeds, adapter.decompose() should NOT be called
    expect(adapterDecomposeCalls).toHaveLength(0);
  });
});
