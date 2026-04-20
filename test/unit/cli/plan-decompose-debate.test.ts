/**
 * Unit tests — planDecomposeCommand debate integration via adapter.decompose() path (US-004)
 *
 * These tests cover the debate integration for adapters that implement decompose().
 * The existing plan-decompose.test.ts (AC-12/13/14) covers debate in the complete() fallback.
 * This file covers the same debate ACs but for the adapter.decompose() path, where
 * the current implementation has NO debate support — tests are RED until implemented.
 *
 * AC-1: When debate.stages.decompose.enabled=true, planDecomposeCommand() runs a DebateSession
 *       and the debate output is parsed through parseDecomposeOutput()
 * AC-2: When debate returns outcome='failed', falls back to adapter.decompose() (not adapter.complete())
 * AC-3: When debate is disabled, adapter.decompose() is called directly without DebateSession
 * AC-4: Debate output wrapped in markdown code fences is parsed by parseDecomposeOutput()
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planDecomposeCommand } from "../../../src/cli/plan";
import type { NaxConfig } from "../../../src/config";
import type { DebateResult } from "../../../src/debate/types";
import type { PRD, UserStory } from "../../../src/prd/types";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const FEATURE = "my-feature";
const STORY_ID = "US-001";

/** A single valid DecomposedStory in JSON array form — no code fences */
const DEBATE_OUTPUT_JSON = JSON.stringify([
  {
    id: "US-001-A",
    title: "Sub-story from debate",
    description: "Produced by debate session",
    acceptanceCriteria: ["AC-1: Passes verification"],
    contextFiles: ["src/handler.ts"],
    tags: ["feature"],
    dependencies: [],
    complexity: "simple",
    reasoning: "Small unit of work",
    estimatedLOC: 40,
    risks: [],
    testStrategy: "test-after",
  },
]);

/** Same output wrapped in ```json ... ``` code fences */
const DEBATE_OUTPUT_JSON_FENCED = `\`\`\`json\n${DEBATE_OUTPUT_JSON}\n\`\`\``;

/** Same output wrapped in plain ``` ... ``` (no language specifier) */
const DEBATE_OUTPUT_PLAIN_FENCED = `\`\`\`\n${DEBATE_OUTPUT_JSON}\n\`\`\``;

function makePassedDebateResult(output: string = DEBATE_OUTPUT_JSON): DebateResult {
  return {
    storyId: STORY_ID,
    stage: "decompose",
    outcome: "passed",
    output,
    rounds: 1,
    debaters: ["claude", "opencode"],
    resolverType: "synthesis",
    proposals: [],
    totalCostUsd: 0,
  };
}

function makeFailedDebateResult(): DebateResult {
  return {
    storyId: STORY_ID,
    stage: "decompose",
    outcome: "failed",
    output: undefined,
    rounds: 0,
    debaters: [],
    resolverType: "synthesis",
    proposals: [],
    totalCostUsd: 0,
  };
}

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: STORY_ID,
    title: "Complex story to decompose",
    description: "Needs breaking down",
    acceptanceCriteria: ["AC-1: Does A", "AC-2: Does B"],
    tags: ["feature"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/foo.ts"],
    routing: {
      complexity: "complex",
      testStrategy: "tdd-simple",
      reasoning: "many concerns",
      modelTier: "balanced",
    },
    ...overrides,
  };
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

/** Valid sub-story returned by adapter.decompose() (has contextFiles, complexity, testStrategy) */
function makeDecomposeAdapterResult() {
  return {
    stories: [
      {
        id: "US-001-A",
        title: "Sub-story A",
        description: "First sub-story",
        acceptanceCriteria: ["AC-1: Does thing"],
        contextFiles: ["src/handler.ts"],
        tags: ["feature"],
        dependencies: [],
        complexity: "simple" as const,
        reasoning: "Small scope",
        estimatedLOC: 40,
        risks: [],
        testStrategy: "test-after" as const,
      },
    ],
  };
}

function makeDebateStageConfig(enabled: boolean) {
  return {
    enabled,
    resolver: { type: "synthesis" as const },
    sessionMode: "one-shot" as const,
    rounds: 1,
    timeoutSeconds: 60,
  };
}

function makeConfigWithDebate(debateDecomposeEnabled: boolean): NaxConfig {
  return {
    agent: { default: "claude" },
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
    debate: {
      enabled: debateDecomposeEnabled,
      agents: 2,
      maxConcurrentDebaters: 2,
      stages: {
        decompose: makeDebateStageConfig(debateDecomposeEnabled),
        plan: makeDebateStageConfig(false),
        review: makeDebateStageConfig(false),
        acceptance: makeDebateStageConfig(false),
        rectification: makeDebateStageConfig(false),
        escalation: makeDebateStageConfig(false),
      },
    },
  } as never;
}

/** Fake adapter that implements decompose() — triggers the adapter.decompose() branch */
function makeDecomposeAdapter() {
  return {
    decompose: mock(async (_opts: unknown) => makeDecomposeAdapterResult()),
    complete: mock(async (_prompt: string) => DEBATE_OUTPUT_JSON),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save originals
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

describe("planDecomposeCommand — debate via adapter.decompose() path (US-004)", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;

  function setupDeps(prd: PRD, adapter = makeDecomposeAdapter()) {
    const prdPath = join(tmpDir, ".nax", "features", FEATURE, "prd.json");

    _planDeps.existsSync = mock((p: string) => p === prdPath);
    _planDeps.readFile = mock(async (p: string) => {
      if (p === prdPath) return JSON.stringify(prd);
      return "";
    });
    _planDeps.writeFile = mock(async (p: string, content: string) => {
      capturedWriteArgs.push([p, content]);
    });
    _planDeps.scanCodebase = mock(async () => ({
      fileTree: "└── src/\n    └── index.ts",
      dependencies: {},
      devDependencies: {},
      testPatterns: [],
    }));
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.getAgent = mock(() => adapter as never);
  }

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-debate-");
    capturedWriteArgs = [];
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
  // AC-1: debate enabled + adapter has decompose() → DebateSession runs
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-1: creates DebateSession when adapter has decompose() and debate.stages.decompose.enabled=true", async () => {
    const prd = makePrd();
    const adapter = makeDecomposeAdapter();
    setupDeps(prd, adapter);

    const createDebateMock = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult()),
    }));
    _planDeps.createDebateSession = createDebateMock as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(createDebateMock).toHaveBeenCalledTimes(1);
  });

  test("AC-1: DebateSession is created with stage='decompose'", async () => {
    const prd = makePrd();
    setupDeps(prd);

    const capturedOpts: unknown[] = [];
    _planDeps.createDebateSession = mock((opts: unknown) => {
      capturedOpts.push(opts);
      return { run: mock(async () => makePassedDebateResult()) };
    }) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(capturedOpts[0]).toMatchObject({ stage: "decompose" });
  });

  test("AC-1: adapter.decompose() is NOT called when debate succeeds", async () => {
    const prd = makePrd();
    const adapter = makeDecomposeAdapter();
    setupDeps(prd, adapter);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult()),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(adapter.decompose).not.toHaveBeenCalled();
  });

  test("AC-1: debate output is parsed through parseDecomposeOutput() and sub-stories written to PRD", async () => {
    const prd = makePrd();
    setupDeps(prd);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult(DEBATE_OUTPUT_JSON)),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(capturedWriteArgs).toHaveLength(1);
    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStory = written.userStories.find((s) => s.id === "US-001-A");
    expect(subStory).toBeDefined();
    expect(subStory?.title).toBe("Sub-story from debate");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2: debate returns 'failed' → fall back to adapter.decompose(), not adapter.complete()
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-2: calls adapter.decompose() when debate outcome='failed'", async () => {
    const prd = makePrd();
    const adapter = makeDecomposeAdapter();
    setupDeps(prd, adapter);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makeFailedDebateResult()),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(adapter.decompose).toHaveBeenCalledTimes(1);
  });

  test("AC-2: does NOT call adapter.complete() when debate fails — decompose() is the fallback", async () => {
    const prd = makePrd();
    const adapter = makeDecomposeAdapter();
    setupDeps(prd, adapter);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makeFailedDebateResult()),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(adapter.complete).not.toHaveBeenCalled();
  });

  test("AC-2: PRD is updated with sub-stories from adapter.decompose() fallback", async () => {
    const prd = makePrd();
    const adapter = makeDecomposeAdapter();
    setupDeps(prd, adapter);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makeFailedDebateResult()),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(capturedWriteArgs).toHaveLength(1);
    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    expect(written.userStories.some((s) => s.id === "US-001-A")).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-3: debate disabled → adapter.decompose() called directly, no DebateSession
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-3: does NOT create DebateSession when debate is disabled", async () => {
    const prd = makePrd();
    const adapter = makeDecomposeAdapter();
    setupDeps(prd, adapter);

    const createDebateMock = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult()),
    }));
    _planDeps.createDebateSession = createDebateMock as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(false), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(createDebateMock).not.toHaveBeenCalled();
  });

  test("AC-3: calls adapter.decompose() directly when debate is disabled", async () => {
    const prd = makePrd();
    const adapter = makeDecomposeAdapter();
    setupDeps(prd, adapter);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult()),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(false), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    expect(adapter.decompose).toHaveBeenCalledTimes(1);
  });

  test("AC-3: adapter.decompose() called directly when no debate config present", async () => {
    const prd = makePrd();
    const adapter = makeDecomposeAdapter();
    setupDeps(prd, adapter);

    const createDebateMock = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult()),
    }));
    _planDeps.createDebateSession = createDebateMock as never;

    await planDecomposeCommand(
      tmpDir,
      { autoMode: { defaultAgent: "claude" } } as never,
      { feature: FEATURE, storyId: STORY_ID },
    );

    expect(createDebateMock).not.toHaveBeenCalled();
    expect(adapter.decompose).toHaveBeenCalledTimes(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-4: code-fenced debate output parsed successfully via parseDecomposeOutput()
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-4: parses debate output wrapped in ```json ... ``` code fences", async () => {
    const prd = makePrd();
    setupDeps(prd);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult(DEBATE_OUTPUT_JSON_FENCED)),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStory = written.userStories.find((s) => s.id === "US-001-A");
    expect(subStory).toBeDefined();
    expect(subStory?.title).toBe("Sub-story from debate");
  });

  test("AC-4: parses debate output wrapped in plain ``` ... ``` code fences (no language tag)", async () => {
    const prd = makePrd();
    setupDeps(prd);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult(DEBATE_OUTPUT_PLAIN_FENCED)),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    expect(written.userStories.some((s) => s.id === "US-001-A")).toBe(true);
  });

  test("AC-4: sub-stories from code-fenced debate output are written with correct parentStoryId", async () => {
    const prd = makePrd();
    setupDeps(prd);

    _planDeps.createDebateSession = mock((_opts: unknown) => ({
      run: mock(async () => makePassedDebateResult(DEBATE_OUTPUT_JSON_FENCED)),
    })) as never;

    await planDecomposeCommand(tmpDir, makeConfigWithDebate(true), {
      feature: FEATURE,
      storyId: STORY_ID,
    });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStory = written.userStories.find((s) => s.id === "US-001-A");
    expect(subStory?.parentStoryId).toBe(STORY_ID);
  });
});
