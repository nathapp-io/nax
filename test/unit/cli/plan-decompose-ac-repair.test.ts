/**
 * Unit tests for planDecomposeCommand — AC overflow repair loop (issue #227)
 *
 * Tests the shared maxReplanAttempts budget used for AC count repair:
 * - First attempt invalid (AC overflow), second valid -> succeeds
 * - All attempts invalid -> fails after exactly N attempts
 * - Failure message includes offending sub-story IDs and counts
 * - buildDecomposePrompt includes maxAcCount guidance in plan-mode prompts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planDecomposeCommand } from "../../../src/cli/plan";
import { buildDecomposePrompt } from "../../../src/agents/shared/decompose";
import type { DecomposeOptions, DecomposedStory } from "../../../src/agents/shared/types-extended";
import type { NaxConfig } from "../../../src/config";
import { NaxError } from "../../../src/errors";
import type { PRD, UserStory } from "../../../src/prd/types";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "repair-feature";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Original story",
    description: "Description",
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/foo.ts"],
    routing: {
      complexity: "medium",
      testStrategy: "test-after",
      reasoning: "medium",
      modelTier: "balanced",
    },
    ...overrides,
  };
}

function makePrd(stories: UserStory[] = [makeStory()]): PRD {
  return {
    project: "test-project",
    feature: FEATURE,
    branchName: "feat/repair-feature",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: stories,
  };
}

function makeValidSubStory(id: string): DecomposedStory {
  return {
    id,
    title: `Sub ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["AC-1: Does something", "AC-2: Does another"],
    tags: [],
    dependencies: [],
    complexity: "simple",
    contextFiles: ["src/foo.ts"],
    reasoning: "simple",
    estimatedLOC: 50,
    risks: [],
    testStrategy: "test-after",
  };
}

function makeOversizedSubStory(id: string, acCount: number): DecomposedStory {
  return {
    ...makeValidSubStory(id),
    acceptanceCriteria: Array.from({ length: acCount }, (_, i) => `AC-${i + 1}: criterion`),
  };
}

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return {
    precheck: {
      storySizeGate: {
        enabled: true,
        maxAcCount: 5,
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
// Originals for afterEach restoration
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
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — AC overflow repair loop (issue #227)", () => {
  let tmpDir: string;

  function setupBaseDeps(prd: PRD) {
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");
    _planDeps.existsSync = mock((path: string) => path === prdPath);
    _planDeps.readFile = mock(async (path: string) => (path === prdPath ? JSON.stringify(prd) : ""));
    _planDeps.writeFile = mock(async () => {});
    _planDeps.scanCodebase = mock(async () => makeFakeScan());
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createDebateSession = mock(() => ({ run: mock(async () => ({ outcome: "failed" })) }) as never);
  }

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-ac-repair-test-");
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
  // Test 1: First attempt invalid, second valid -> succeeds
  // ──────────────────────────────────────────────────────────────────────────

  test("first decompose returns AC overflow, second returns valid -> succeeds and writes PRD", async () => {
    const prd = makePrd();
    setupBaseDeps(prd);

    let callCount = 0;
    _planDeps.getAgent = mock(
      () =>
        ({
          decompose: mock(async (_opts: DecomposeOptions) => {
            callCount++;
            if (callCount === 1) {
              // First call: oversized (6 ACs, max is 5)
              return { stories: [makeOversizedSubStory("US-001-A", 6), makeValidSubStory("US-001-B")] };
            }
            // Second call: valid
            return { stories: [makeValidSubStory("US-001-A"), makeValidSubStory("US-001-B")] };
          }),
        }) as never,
    );

    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).resolves.not.toThrow();

    expect(callCount).toBe(2);
    expect(_planDeps.writeFile).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 2: All attempts return AC overflow -> fails after exactly N attempts
  // ──────────────────────────────────────────────────────────────────────────

  test("all decompose attempts return AC overflow -> fails after exactly maxReplanAttempts calls", async () => {
    const prd = makePrd();
    setupBaseDeps(prd);

    let callCount = 0;
    _planDeps.getAgent = mock(
      () =>
        ({
          decompose: mock(async (_opts: DecomposeOptions) => {
            callCount++;
            return { stories: [makeOversizedSubStory("US-001-A", 8)] };
          }),
        }) as never,
    );

    const config = makeConfig(); // maxReplanAttempts: 3
    await expect(
      planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });

    expect(callCount).toBe(3);
  });

  test("respects maxReplanAttempts=1 -> fails after a single attempt", async () => {
    const prd = makePrd();
    setupBaseDeps(prd);

    let callCount = 0;
    _planDeps.getAgent = mock(
      () =>
        ({
          decompose: mock(async (_opts: DecomposeOptions) => {
            callCount++;
            return { stories: [makeOversizedSubStory("US-001-A", 8)] };
          }),
        }) as never,
    );

    const config = makeConfig({
      precheck: {
        storySizeGate: {
          enabled: true,
          maxAcCount: 5,
          maxDescriptionLength: 3000,
          maxBulletPoints: 12,
          action: "block",
          maxReplanAttempts: 1,
        },
      },
    } as Partial<NaxConfig>);

    await expect(
      planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toMatchObject({ code: "DECOMPOSE_VALIDATION_FAILED" });

    expect(callCount).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 3: Failure message includes offending sub-story IDs and counts
  // ──────────────────────────────────────────────────────────────────────────

  test("exhausted-budget error message includes offending sub-story IDs and AC counts", async () => {
    const prd = makePrd();
    setupBaseDeps(prd);

    _planDeps.getAgent = mock(
      () =>
        ({
          decompose: mock(async (_opts: DecomposeOptions) => ({
            stories: [
              makeOversizedSubStory("US-001-A", 8),
              makeOversizedSubStory("US-001-B", 7),
              makeValidSubStory("US-001-C"),
            ],
          })),
        }) as never,
    );

    let caught: NaxError | undefined;
    try {
      await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });
    } catch (err) {
      caught = err as NaxError;
    }

    expect(caught).toBeInstanceOf(NaxError);
    expect(caught?.code).toBe("DECOMPOSE_VALIDATION_FAILED");
    expect(caught?.message).toContain("US-001-A");
    expect(caught?.message).toContain("US-001-B");
    expect(caught?.message).toContain("8 ACs");
    expect(caught?.message).toContain("7 ACs");
    // Valid story should NOT appear in the error
    expect(caught?.message).not.toContain("US-001-C");
  });

  test("exhausted-budget error message includes attempt count and maxAcCount", async () => {
    const prd = makePrd();
    setupBaseDeps(prd);

    _planDeps.getAgent = mock(
      () =>
        ({
          decompose: mock(async (_opts: DecomposeOptions) => ({
            stories: [makeOversizedSubStory("US-001-A", 9)],
          })),
        }) as never,
    );

    let caught: NaxError | undefined;
    try {
      await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });
    } catch (err) {
      caught = err as NaxError;
    }

    expect(caught?.message).toContain("3 attempts");
    expect(caught?.message).toContain("max 5");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Test 4: Repair hint is passed in subsequent decompose calls
  // ──────────────────────────────────────────────────────────────────────────

  test("repair hint containing violation info is appended to codebaseContext on retry", async () => {
    const prd = makePrd();
    setupBaseDeps(prd);

    const capturedContexts: string[] = [];
    let callCount = 0;

    _planDeps.getAgent = mock(
      () =>
        ({
          decompose: mock(async (opts: DecomposeOptions) => {
            capturedContexts.push(opts.codebaseContext);
            callCount++;
            if (callCount === 1) {
              return { stories: [makeOversizedSubStory("US-001-A", 6)] };
            }
            return { stories: [makeValidSubStory("US-001-A"), makeValidSubStory("US-001-B")] };
          }),
        }) as never,
    );

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    expect(capturedContexts).toHaveLength(2);
    // First call: no repair hint
    expect(capturedContexts[0]).not.toContain("REPAIR REQUIRED");
    // Second call: contains repair hint with violation info
    expect(capturedContexts[1]).toContain("REPAIR REQUIRED");
    expect(capturedContexts[1]).toContain("US-001-A");
    expect(capturedContexts[1]).toContain("maxAcCount of 5");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: buildDecomposePrompt includes maxAcCount guidance in plan-mode
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDecomposePrompt — maxAcCount prompt hardening (issue #227)", () => {
  function makeTargetStory(): UserStory {
    return {
      id: "US-001",
      title: "Target story",
      description: "Description",
      acceptanceCriteria: ["AC-1"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      contextFiles: ["src/foo.ts"],
      routing: { complexity: "medium", testStrategy: "test-after", reasoning: "", modelTier: "balanced" },
    };
  }

  function makeDecomposeOptions(maxAcCount?: number): DecomposeOptions {
    return {
      specContent: "",
      codebaseContext: "## Codebase\n\nsome context",
      workdir: "/tmp/test",
      targetStory: makeTargetStory(),
      siblings: [],
      config: maxAcCount != null
        ? ({
            precheck: {
              storySizeGate: {
                enabled: true,
                maxAcCount,
                maxDescriptionLength: 3000,
                maxBulletPoints: 12,
                action: "block",
                maxReplanAttempts: 3,
              },
            },
          } as Partial<NaxConfig>)
        : undefined,
    };
  }

  test("prompt includes maxAcCount constraint when config has storySizeGate.maxAcCount", () => {
    const prompt = buildDecomposePrompt(makeDecomposeOptions(8));
    expect(prompt).toContain("8");
    expect(prompt).toContain("acceptance criteria");
  });

  test("prompt includes explicit split instruction when maxAcCount is set", () => {
    const prompt = buildDecomposePrompt(makeDecomposeOptions(6));
    expect(prompt).toContain("split");
    expect(prompt).toContain("6");
  });

  test("prompt does not include AC constraint section when config is absent", () => {
    const prompt = buildDecomposePrompt(makeDecomposeOptions(undefined));
    expect(prompt).not.toContain("Acceptance Criteria Constraint");
  });

  test("prompt does not include AC constraint when maxAcCount is not set in config", () => {
    const opts: DecomposeOptions = {
      specContent: "",
      codebaseContext: "context",
      workdir: "/tmp",
      targetStory: makeTargetStory(),
      config: {} as Partial<NaxConfig>,
    };
    const prompt = buildDecomposePrompt(opts);
    expect(prompt).not.toContain("Acceptance Criteria Constraint");
  });
});
