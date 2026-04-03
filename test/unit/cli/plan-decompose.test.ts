/**
 * Unit tests for planDecomposeCommand (US-002)
 *
 * Tests decomposing a story into sub-stories via:
 * - PRD/story validation guards
 * - Sub-story structural validation
 * - PRD update and write-back
 * - Debate session integration
 * - bin/nax.ts CLI wiring
 *
 * All tests FAIL initially — planDecomposeCommand does not yet exist.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planDecomposeCommand } from "../../../src/cli/plan";
import type { NaxConfig } from "../../../src/config";
import { NaxError } from "../../../src/errors";
import type { PRD, UserStory } from "../../../src/prd/types";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

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
  return {
    project: "test-project",
    feature: FEATURE,
    branchName: "feat/my-feature",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: stories,
  };
}

function makeSubStory(id: string, overrides: Partial<UserStory> = {}): UserStory {
  return {
    id,
    title: `Sub-story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["AC-1: Does something"],
    tags: ["feature"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/foo.ts"],
    routing: {
      complexity: "simple",
      testStrategy: "test-after",
      reasoning: "simple",
      modelTier: "balanced",
    },
    ...overrides,
  };
}

function makeDecomposeResponse(stories: UserStory[]): string {
  return JSON.stringify(stories);
}

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
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
    autoMode: { defaultAgent: "claude" },
    ...overrides,
  } as NaxConfig;
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
const origGetAgent = _planDeps.getAgent;
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

describe("planDecomposeCommand", () => {
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
      complete: mock(async (prompt: string) => {
        capturedCompleteArgs.push(prompt);
        return makeDecomposeResponse(stories);
      }),
    };
    _planDeps.getAgent = mock(() => fakeAdapter as never);
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
    _planDeps.getAgent = origGetAgent;
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
  // AC-1: exported from src/cli/plan.ts with correct signature
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-1: planDecomposeCommand is exported as a function", () => {
    expect(typeof planDecomposeCommand).toBe("function");
  });

  test("AC-1: planDecomposeCommand returns a Promise", async () => {
    const prd = makePrd();
    setupDeps(prd);

    const result = planDecomposeCommand(tmpDir, makeConfig(), {
      feature: FEATURE,
      storyId: "US-001",
    });

    expect(result).toBeInstanceOf(Promise);
    await result.catch(() => {});
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2: PRD_NOT_FOUND when prd.json does not exist
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-2: throws NaxError with code PRD_NOT_FOUND when prd.json does not exist", async () => {
    _planDeps.existsSync = mock(() => false);

    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), {
        feature: FEATURE,
        storyId: "US-001",
      }),
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

  // ──────────────────────────────────────────────────────────────────────────
  // AC-3: STORY_NOT_FOUND when storyId is not in PRD
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-3: throws NaxError with code STORY_NOT_FOUND when storyId not in PRD", async () => {
    const prd = makePrd([makeStory({ id: "US-001" })]);
    setupDeps(prd);

    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), {
        feature: FEATURE,
        storyId: "US-999",
      }),
    ).rejects.toMatchObject({ code: "STORY_NOT_FOUND" });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-4: STORY_ALREADY_DECOMPOSED when story has status 'decomposed'
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-4: throws NaxError with code STORY_ALREADY_DECOMPOSED when story is already decomposed", async () => {
    const prd = makePrd([makeStory({ id: "US-001", status: "decomposed" })]);
    setupDeps(prd);

    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), {
        feature: FEATURE,
        storyId: "US-001",
      }),
    ).rejects.toMatchObject({ code: "STORY_ALREADY_DECOMPOSED" });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5: prompt includes target story JSON, sibling IDs/titles, codebase context
  // ──────────────────────────────────────────────────────────────────────────

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
    // buildCodebaseContext emits "Codebase Structure" header and deps
    expect(prompt).toContain("Codebase");
    expect(prompt).toContain("zod");
  });

  test("AC-5: adapter.complete() is called with jsonMode: true", async () => {
    const prd = makePrd();
    const capturedOpts: unknown[] = [];

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
    _planDeps.getAgent = mock(
      () =>
        ({
          complete: mock(async (prompt: string, opts: unknown) => {
            capturedCompleteArgs.push(prompt);
            capturedOpts.push(opts);
            return makeDecomposeResponse([makeSubStory("US-001-A"), makeSubStory("US-001-B")]);
          }),
        }) as never,
    );

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    expect(capturedOpts[0]).toMatchObject({ jsonMode: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-6: DECOMPOSE_VALIDATION_FAILED for empty contextFiles
  // ──────────────────────────────────────────────────────────────────────────

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

  // ──────────────────────────────────────────────────────────────────────────
  // AC-7: DECOMPOSE_VALIDATION_FAILED for missing routing fields
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-7: throws DECOMPOSE_VALIDATION_FAILED when sub-story missing routing.complexity", async () => {
    const prd = makePrd();
    const badStory = makeSubStory("US-001-A");
    if (badStory.routing) delete (badStory.routing as Partial<typeof badStory.routing>).complexity;
    setupDeps(prd, [badStory]);

    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
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

  test("AC-7: throws DECOMPOSE_VALIDATION_FAILED when sub-story missing routing.modelTier", async () => {
    const prd = makePrd();
    const badStory = makeSubStory("US-001-A");
    if (badStory.routing) delete (badStory.routing as Partial<typeof badStory.routing>).modelTier;
    setupDeps(prd, [badStory]);

    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
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

  // ──────────────────────────────────────────────────────────────────────────
  // AC-8: DECOMPOSE_VALIDATION_FAILED when AC count exceeds maxAcCount
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-8: throws DECOMPOSE_VALIDATION_FAILED when sub-story exceeds maxAcCount", async () => {
    const config = makeConfig(); // maxAcCount = 6
    const tooManyAcs = Array.from({ length: 7 }, (_, i) => `AC-${i + 1}: criterion`);
    const prd = makePrd();
    setupDeps(prd, [makeSubStory("US-001-A", { acceptanceCriteria: tooManyAcs })]);

    await expect(
      planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });
  });

  test("AC-8: accepts sub-story with exactly maxAcCount acceptance criteria", async () => {
    const config = makeConfig(); // maxAcCount = 6
    const exactAcs = Array.from({ length: 6 }, (_, i) => `AC-${i + 1}: criterion`);
    const prd = makePrd();
    setupDeps(prd, [
      makeSubStory("US-001-A", { acceptanceCriteria: exactAcs }),
      makeSubStory("US-001-B"),
    ]);

    await expect(
      planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" }),
    ).resolves.not.toThrow();
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

    const adapterCompleteCalls: string[] = [];
    _planDeps.getAgent = mock(
      () =>
        ({
          complete: mock(async (prompt: string) => {
            adapterCompleteCalls.push(prompt);
            return makeDecomposeResponse(stories);
          }),
        }) as never,
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

    // When debate succeeds, adapter.complete() should NOT be called
    expect(adapterCompleteCalls).toHaveLength(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-13: debate outcome === 'failed' falls back to adapter.complete()
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-13: falls back to adapter.complete() when debate outcome is 'failed'", async () => {
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

    const adapterCompleteCalls: string[] = [];
    _planDeps.getAgent = mock(
      () =>
        ({
          complete: mock(async (prompt: string) => {
            adapterCompleteCalls.push(prompt);
            return makeDecomposeResponse(stories);
          }),
        }) as never,
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

    expect(adapterCompleteCalls).toHaveLength(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-14: no debate config → adapter.complete() called directly
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-14: calls adapter.complete() directly when debate.stages.decompose is not configured", async () => {
    const prd = makePrd();
    const adapterCompleteCalls: string[] = [];

    setupDeps(prd);
    _planDeps.getAgent = mock(
      () =>
        ({
          complete: mock(async (prompt: string) => {
            adapterCompleteCalls.push(prompt);
            return makeDecomposeResponse([makeSubStory("US-001-A"), makeSubStory("US-001-B")]);
          }),
        }) as never,
    );

    const createDebateCalled: boolean[] = [];
    _planDeps.createDebateSession = mock(() => {
      createDebateCalled.push(true);
      return {} as never;
    });

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    expect(adapterCompleteCalls).toHaveLength(1);
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
      makeConfig({ debate: { enabled: false, agents: 2, stages: {} as never } }),
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

// ─────────────────────────────────────────────────────────────────────────────
// AC-11: bin/nax.ts registers --decompose option on the plan command
// ─────────────────────────────────────────────────────────────────────────────

describe("bin/nax.ts plan command — --decompose wiring (AC-11)", () => {
  test("AC-11: bin/nax.ts imports planDecomposeCommand", async () => {
    const binSource = await Bun.file(
      join(import.meta.dir, "../../../bin/nax.ts"),
    ).text();

    expect(binSource).toContain("planDecomposeCommand");
  });

  test("AC-11: bin/nax.ts registers --decompose <storyId> option on plan command", async () => {
    const binSource = await Bun.file(
      join(import.meta.dir, "../../../bin/nax.ts"),
    ).text();

    expect(binSource).toContain("--decompose");
  });

  test("AC-11: plan command --help output includes --decompose option", () => {
    const result = Bun.spawnSync(
      ["bun", join(import.meta.dir, "../../../bin/nax.ts"), "plan", "--help"],
      { stdout: "pipe", stderr: "pipe" },
    );

    const helpOutput = result.stdout.toString();
    expect(helpOutput).toContain("--decompose");
  });
});
