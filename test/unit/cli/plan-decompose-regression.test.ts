/**
 * Regression tests for fenced JSON parsing and contract parity (US-005)
 *
 * Tests the end-to-end flow:
 *   planDecomposeCommand → adapter.decompose → parseDecomposeOutput
 *
 * All tests FAIL initially (RED phase) — implementation follows.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planDecomposeCommand } from "../../../src/cli/plan";
import { parseDecomposeOutput } from "../../../src/agents/shared/decompose";
import { mapDecomposedStoriesToUserStories } from "../../../src/prd/decompose-mapper";
import type { NaxConfig } from "../../../src/config";
import type { DecomposedStory } from "../../../src/agents/shared/types-extended";
import type { PRD, UserStory } from "../../../src/prd/types";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "test-feature";

function makeDecomposedStory(id: string, overrides: Partial<DecomposedStory> = {}): DecomposedStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["AC-1: Does something"],
    tags: ["feature"],
    dependencies: [],
    complexity: "simple",
    contextFiles: ["src/foo.ts"],
    reasoning: "simple complexity",
    estimatedLOC: 50,
    risks: [],
    testStrategy: "test-after",
    ...overrides,
  };
}

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
    routing: {
      complexity: "complex",
      testStrategy: "test-after",
      reasoning: "complex",
      modelTier: "balanced",
    },
  };
}

function makePrd(story: UserStory = makeTargetStory()): PRD {
  return {
    project: "test-project",
    feature: FEATURE,
    branchName: "feat/test-feature",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: [story],
  };
}

function makeConfig(): NaxConfig {
  return {
    agent: { default: "claude" },
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
// Dep originals for afterEach restoration
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
// Shared setup helpers
// ─────────────────────────────────────────────────────────────────────────────

function setupBaseDeps(tmpDir: string, prd: PRD, capturedWrites: Array<[string, string]>) {
  const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");

  _planDeps.existsSync = mock((path: string) => path === prdPath);
  _planDeps.readFile = mock(async (path: string) => {
    if (path === prdPath) return JSON.stringify(prd);
    return "";
  });
  _planDeps.writeFile = mock(async (path: string, content: string) => {
    capturedWrites.push([path, content]);
  });
  _planDeps.scanCodebase = mock(async () => makeFakeScan());
  _planDeps.discoverWorkspacePackages = mock(async () => []);
  _planDeps.readPackageJson = mock(async () => null);
  _planDeps.readPackageJsonAt = mock(async () => null);
  _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
  _planDeps.mkdirp = mock(async () => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 & AC-2: fenced JSON parsing through the plan decompose flow
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — fenced JSON parsing regression", () => {
  let tmpDir: string;
  let capturedWrites: Array<[string, string]>;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-regression-");
    capturedWrites = [];
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

  test("AC-1: succeeds when adapter.decompose returns json-fenced JSON (```json ... ```)", async () => {
    const stories = [makeDecomposedStory("US-001-A"), makeDecomposedStory("US-001-B")];
    const fencedJson = `\`\`\`json\n${JSON.stringify(stories)}\n\`\`\``;

    const prd = makePrd();
    setupBaseDeps(tmpDir, prd, capturedWrites);
    _planDeps.getAgent = mock(() => ({
      decompose: async () => ({ stories: parseDecomposeOutput(fencedJson) }),
    }) as never);

    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).resolves.not.toThrow();
  });

  test("AC-2: succeeds when adapter.decompose returns backtick-fenced JSON (``` ... ``` no lang tag)", async () => {
    const stories = [makeDecomposedStory("US-001-A"), makeDecomposedStory("US-001-B")];
    const fencedJson = `\`\`\`\n${JSON.stringify(stories)}\n\`\`\``;

    const prd = makePrd();
    setupBaseDeps(tmpDir, prd, capturedWrites);
    _planDeps.getAgent = mock(() => ({
      decompose: async () => ({ stories: parseDecomposeOutput(fencedJson) }),
    }) as never);

    await expect(
      planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).resolves.not.toThrow();
  });

  test("AC-2: written PRD contains sub-stories from backtick-fenced adapter output", async () => {
    const stories = [makeDecomposedStory("US-001-A"), makeDecomposedStory("US-001-B")];
    const fencedJson = `\`\`\`\n${JSON.stringify(stories)}\n\`\`\``;

    const prd = makePrd();
    setupBaseDeps(tmpDir, prd, capturedWrites);
    _planDeps.getAgent = mock(() => ({
      decompose: async () => ({ stories: parseDecomposeOutput(fencedJson) }),
    }) as never);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWrites[0][1]) as PRD;
    const ids = written.userStories.map((s) => s.id);
    expect(ids).toContain("US-001-A");
    expect(ids).toContain("US-001-B");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3: contract parity — planDecomposeCommand output matches adapter.decompose output
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — contract parity with adapter.decompose output", () => {
  let tmpDir: string;
  let capturedWrites: Array<[string, string]>;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-parity-");
    capturedWrites = [];
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

  test("AC-3: written sub-story id matches DecomposedStory id from adapter.decompose", async () => {
    const decomposed = [makeDecomposedStory("US-001-A"), makeDecomposedStory("US-001-B")];
    const prd = makePrd();
    setupBaseDeps(tmpDir, prd, capturedWrites);
    _planDeps.getAgent = mock(() => ({
      decompose: async () => ({ stories: decomposed }),
    }) as never);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWrites[0][1]) as PRD;
    const subA = written.userStories.find((s) => s.id === "US-001-A");
    expect(subA).toBeDefined();
    expect(subA?.id).toBe(decomposed[0].id);
  });

  test("AC-3: written sub-story title matches DecomposedStory title from adapter.decompose", async () => {
    const decomposed = [makeDecomposedStory("US-001-A", { title: "Unique title from LLM" })];
    const prd = makePrd();
    setupBaseDeps(tmpDir, prd, capturedWrites);
    _planDeps.getAgent = mock(() => ({
      decompose: async () => ({ stories: decomposed }),
    }) as never);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWrites[0][1]) as PRD;
    const subA = written.userStories.find((s) => s.id === "US-001-A");
    expect(subA?.title).toBe("Unique title from LLM");
  });

  test("AC-3: written sub-story contextFiles matches DecomposedStory contextFiles", async () => {
    const decomposed = [makeDecomposedStory("US-001-A", { contextFiles: ["src/bar.ts", "src/baz.ts"] })];
    const prd = makePrd();
    setupBaseDeps(tmpDir, prd, capturedWrites);
    _planDeps.getAgent = mock(() => ({
      decompose: async () => ({ stories: decomposed }),
    }) as never);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWrites[0][1]) as PRD;
    const subA = written.userStories.find((s) => s.id === "US-001-A");
    expect(subA?.contextFiles).toEqual(["src/bar.ts", "src/baz.ts"]);
  });

  test("AC-3: written sub-story routing.complexity matches DecomposedStory complexity", async () => {
    const decomposed = [makeDecomposedStory("US-001-A", { complexity: "complex" })];
    const prd = makePrd();
    setupBaseDeps(tmpDir, prd, capturedWrites);
    _planDeps.getAgent = mock(() => ({
      decompose: async () => ({ stories: decomposed }),
    }) as never);

    await planDecomposeCommand(tmpDir, makeConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWrites[0][1]) as PRD;
    const subA = written.userStories.find((s) => s.id === "US-001-A");
    expect(subA?.routing?.complexity).toBe("complex");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-4: meta-test — split plan-decompose tests must not assert { subStories } envelope
// ─────────────────────────────────────────────────────────────────────────────

describe("plan-decompose split tests — no deprecated subStories envelope assertions", () => {
  test("AC-4: split plan-decompose tests do not contain { subStories } envelope in adapter mocks", async () => {
    const sources = await Promise.all([
      Bun.file(join(import.meta.dir, "plan-decompose-ac-repair.test.ts")).text(),
      Bun.file(join(import.meta.dir, "plan-decompose-adapter.test.ts")).text(),
      Bun.file(join(import.meta.dir, "plan-decompose-mapper.test.ts")).text(),
      Bun.file(join(import.meta.dir, "plan-decompose-cli-wiring.test.ts")).text(),
      Bun.file(join(import.meta.dir, "plan-decompose-guards.test.ts")).text(),
      Bun.file(join(import.meta.dir, "plan-decompose-writeback.test.ts")).text(),
      Bun.file(join(import.meta.dir, "plan-decompose-ac13-14.test.ts")).text(),
      Bun.file(join(import.meta.dir, "plan-decompose-debate.test.ts")).text(),
    ]);

    // The deprecated complete() path used JSON.stringify({ subStories }). After US-002,
    // adapter.decompose() returns DecomposedStory[] directly — no wrapper object.
    for (const source of sources) {
      expect(source).not.toContain("JSON.stringify({ subStories");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5: validation error includes entry index and field name
// ─────────────────────────────────────────────────────────────────────────────

describe("mapDecomposedStoriesToUserStories — validation error format", () => {
  test("AC-5: error message includes 'index 2' when story at index 2 is missing id", () => {
    const stories: DecomposedStory[] = [
      makeDecomposedStory("US-001-A"),
      makeDecomposedStory("US-001-B"),
      { ...makeDecomposedStory("US-001-C"), id: "" },
    ];

    let caught: unknown;
    try {
      mapDecomposedStoriesToUserStories(stories, "US-001");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("index 2");
  });

  test("AC-5: error message includes 'id' when story at index 2 is missing id", () => {
    const stories: DecomposedStory[] = [
      makeDecomposedStory("US-001-A"),
      makeDecomposedStory("US-001-B"),
      { ...makeDecomposedStory("US-001-C"), id: "" },
    ];

    let caught: unknown;
    try {
      mapDecomposedStoriesToUserStories(stories, "US-001");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as Error).message).toContain("id");
  });

  test("AC-5: stories at indices 0 and 1 do not trigger the index-2 error", () => {
    const validStories: DecomposedStory[] = [
      makeDecomposedStory("US-001-A"),
      makeDecomposedStory("US-001-B"),
      makeDecomposedStory("US-001-C"),
    ];

    expect(() => mapDecomposedStoriesToUserStories(validStories, "US-001")).not.toThrow();
  });
});
