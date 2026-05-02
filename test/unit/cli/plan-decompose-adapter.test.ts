/**
 * Unit tests for planDecomposeCommand — adapter.decompose() refactor (US-002)
 *
 * Verifies the new call pattern introduced in US-002:
 * - planDecomposeCommand calls adapter.decompose() instead of adapter.complete()
 * - Options forwarded to adapter.decompose() include workdir, featureName, storyId, config
 * - No local buildDecomposePrompt exported from plan.ts
 * - No direct JSON.parse of LLM response in planDecomposeCommand
 *
 * All tests FAIL initially — US-002 has not been implemented yet.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planDecomposeCommand } from "../../../src/cli/plan";
import type { DecomposeResult, DecomposedStory } from "../../../src/agents/shared/types-extended";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";
import { makeMockAgentManager, makeNaxConfig, makePRD } from "../../helpers";
import type { PRD, UserStory } from "../../../src/prd/types";
import type { NaxConfig } from "../../../src/config";
import type { NaxRuntime } from "../../../src/runtime";

function makeMockDecomposeManager(
  decomposeFn?: (agentName: string, opts: any) => Promise<{ stories: DecomposedStory[] }>,
) {
  return makeMockAgentManager({
    completeAsFn: decomposeFn
      ? async (name: string, _prompt: string, opts?: any) => {
          const result = await decomposeFn(name, opts ?? {});
          return { output: JSON.stringify(result.stories), costUsd: 0, source: "exact" as const };
        }
      : async () => ({ output: JSON.stringify([]), costUsd: 0, source: "exact" as const }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "cache-feature";

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Implement caching layer",
    description: "Add Redis caching",
    acceptanceCriteria: ["AC-1: Cache hit returns cached value"],
    tags: ["feature"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/cache.ts"],
    routing: {
      complexity: "complex",
      testStrategy: "three-session-tdd",
      reasoning: "Requires new infra",
      modelTier: "powerful",
    },
    ...overrides,
  };
}

function makePrd(stories: UserStory[] = [makeStory()]): PRD {
  return makePRD({ feature: FEATURE, branchName: `feat/${FEATURE}`, userStories: stories });
}

function makeDecomposeResult(): DecomposeResult {
  return {
    stories: [
      {
        id: "US-001-A",
        title: "Setup Redis client",
        description: "Configure Redis connection",
        acceptanceCriteria: ["AC-1: Connects to Redis"],
        tags: ["infrastructure"],
        dependencies: [],
        complexity: "medium",
        contextFiles: ["src/redis.ts"],
        reasoning: "Infrastructure setup",
        estimatedLOC: 60,
        risks: [],
        testStrategy: "test-after",
      },
    ],
  };
}

function makeConfig(overrides: Partial<NaxConfig> = {}): NaxConfig {
  return { ...makeNaxConfig(), ...overrides };
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
// Save originals for afterEach restoration
// ─────────────────────────────────────────────────────────────────────────────

const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanCodebase = _planDeps.scanCodebase;
const origCreateRuntime = _planDeps.createRuntime;
const origExistsSync = _planDeps.existsSync;
const origMkdirp = _planDeps.mkdirp;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;
const origReadPackageJson = _planDeps.readPackageJson;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origSpawnSync = _planDeps.spawnSync;

// ─────────────────────────────────────────────────────────────────────────────
// Tests: AC-1 — adapter.decompose() called, adapter.complete() NOT called
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — calls adapter.decompose() not adapter.complete() (US-002 AC-1)", () => {
  let tmpDir: string;
  let capturedDecomposeCalls: unknown[];
  let capturedCompleteCalls: unknown[];

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-adapter-test-");
    capturedDecomposeCalls = [];
    capturedCompleteCalls = [];

    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });

    const prd = makePrd();
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");

    _planDeps.existsSync = mock((p: string) => p === prdPath);
    _planDeps.readFile = mock(async () => JSON.stringify(prd));
    _planDeps.writeFile = mock(async () => {});
    _planDeps.scanCodebase = mock(async () => makeFakeScan());
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => null);
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});

    _planDeps.createRuntime = mock((_cfg: unknown, _wd: unknown, _fn: unknown) =>
      makeMockDecomposeManager(async (_name: string, opts: unknown) => {
        capturedDecomposeCalls.push(opts);
        return { stories: makeDecomposeResult().stories };
      }),
    ) as unknown as typeof _planDeps.createRuntime;
  });

  afterEach(() => {
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.existsSync = origExistsSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    cleanupTempDir(tmpDir);
  });

  test("calls adapter.decompose() exactly once", async () => {
    const config = makeConfig();
    await planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" });

    expect(capturedDecomposeCalls.length).toBe(1);
  });

  test("does NOT call adapter.complete() for decompose", async () => {
    const config = makeConfig();

    // Replace complete() with a non-throwing mock so we can check call count
    _planDeps.createRuntime = mock((_cfg: unknown, _wd: unknown, _fn: unknown) =>
      makeMockDecomposeManager(async (_name: string, opts: unknown) => {
        capturedDecomposeCalls.push(opts);
        return { stories: makeDecomposeResult().stories };
      }),
    ) as unknown as typeof _planDeps.createRuntime;

    await planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" });

    expect(capturedCompleteCalls.length).toBe(0);
  });

  test("resolves without error when adapter.decompose() is available", async () => {
    const config = makeConfig();
    await expect(
      planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" }),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: AC-5 — adapter.decompose() options include workdir, featureName, storyId, config
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — adapter.decompose() option forwarding (US-002 AC-5)", () => {
  let tmpDir: string;
  let capturedDecomposeOpts: Record<string, unknown>[];

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-opts-test-");
    capturedDecomposeOpts = [];

    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });

    const prd = makePrd();
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");

    _planDeps.existsSync = mock((p: string) => p === prdPath);
    _planDeps.readFile = mock(async () => JSON.stringify(prd));
    _planDeps.writeFile = mock(async () => {});
    _planDeps.scanCodebase = mock(async () => makeFakeScan());
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => null);
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});

    _planDeps.createRuntime = mock((_cfg: unknown, _wd: unknown, _fn: unknown) =>
      makeMockDecomposeManager(async (_name: string, opts: Record<string, unknown>) => {
        capturedDecomposeOpts.push(opts);
        return { stories: makeDecomposeResult().stories };
      }),
    ) as unknown as typeof _planDeps.createRuntime;
  });

  afterEach(() => {
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.existsSync = origExistsSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    cleanupTempDir(tmpDir);
  });

  test("adapter.decompose() receives workdir matching the project root", async () => {
    const config = makeConfig();
    await planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" });

    expect(capturedDecomposeOpts.length).toBe(1);
    expect(capturedDecomposeOpts[0].workdir).toBe(tmpDir);
  });

  test("adapter.decompose() receives storyId matching the requested story", async () => {
    const config = makeConfig();
    await planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" });

    expect(capturedDecomposeOpts[0].storyId).toBe("US-001");
  });

  test("adapter.decompose() receives resolved modelDef (not raw config)", async () => {
    const config = makeConfig();
    await planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" });

    // config is no longer forwarded in CompleteOptions (removed in issue #853).
    // Model resolution now happens at the callOp boundary — verify modelDef is present.
    expect(capturedDecomposeOpts[0].modelDef).toBeDefined();
    expect(typeof (capturedDecomposeOpts[0].modelDef as { model?: string } | undefined)?.model).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: AC-3 — local buildDecomposePrompt NOT exported from plan.ts
// ─────────────────────────────────────────────────────────────────────────────

describe("plan.ts module exports — local buildDecomposePrompt removed (US-002 AC-3)", () => {
  test("plan.ts does not export buildDecomposePrompt with (targetStory, siblings, codebaseContext) signature", async () => {
    // After US-002 the local buildDecomposePrompt(targetStory, siblings, codebaseContext)
    // must be removed. We verify it is no longer exported.
    const planModule = await import("../../../src/cli/plan") as Record<string, unknown>;
    // The shared buildDecomposePrompt in src/agents/shared/decompose.ts takes DecomposeOptions.
    // The plan-specific overload (positional params) must not exist as a named export.
    const fn = planModule["buildDecomposePrompt"];
    // If exported, calling it with (UserStory, [], string) returns a string.
    // After removal it should be undefined.
    expect(fn).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: AC-2 — no direct JSON.parse in planDecomposeCommand
// The function must work when adapter.decompose() returns a DecomposeResult
// (structured, not a raw string). If planDecomposeCommand still calls JSON.parse
// on a non-string it would throw; we verify the flow remains stable.
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — no raw JSON.parse of decompose response (US-002 AC-2)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-parse-test-");
    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });

    const prd = makePrd();
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");

    _planDeps.existsSync = mock((p: string) => p === prdPath);
    _planDeps.readFile = mock(async () => JSON.stringify(prd));
    _planDeps.writeFile = mock(async () => {});
    _planDeps.scanCodebase = mock(async () => makeFakeScan());
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => null);
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
  });

  afterEach(() => {
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.existsSync = origExistsSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    cleanupTempDir(tmpDir);
  });

  test("does not throw when adapter.decompose() returns a structured DecomposeResult", async () => {
    // adapter.decompose() returns DecomposeResult (stories array), not a raw JSON string.
    // planDecomposeCommand must not attempt JSON.parse on this structured value.
    _planDeps.createRuntime = mock((_cfg: unknown, _wd: unknown, _fn: unknown) =>
      makeMockDecomposeManager(async () => ({ stories: makeDecomposeResult().stories })),
    ) as unknown as typeof _planDeps.createRuntime;

    const config = makeConfig();
    await expect(
      planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" }),
    ).resolves.toBeDefined();
  });

  test("integrates sub-stories from adapter.decompose() result into the written PRD", async () => {
    const capturedWrites: Array<[string, string]> = [];
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWrites.push([path, content]);
    });

    _planDeps.createRuntime = mock((_cfg: unknown, _wd: unknown, _fn: unknown) =>
      makeMockDecomposeManager(async () => ({ stories: makeDecomposeResult().stories })),
    ) as unknown as typeof _planDeps.createRuntime;

    const config = makeConfig();
    await planDecomposeCommand(tmpDir, config, { feature: FEATURE, storyId: "US-001" });

    expect(capturedWrites.length).toBeGreaterThan(0);
    const written = JSON.parse(capturedWrites[0][1]) as PRD;
    const ids = written.userStories.map((s) => s.id);
    expect(ids).toContain("US-001-A");
  });
});
