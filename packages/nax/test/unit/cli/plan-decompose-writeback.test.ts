/**
 * Unit tests for planDecomposeCommand (US-002)
 *
 * Covers: PRD write-back — original story status='decomposed',
 * sub-story parentStoryId, and path/content verification (AC-9, AC-10).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  assertDefined,
  assertNaxError,
  cleanupTempDir,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  makeTempDir,
} from "@test/helpers";
import type { DecomposedStory } from "@/agents/shared/types-extended";
import type { CompleteOptions } from "@/agents/types";
import { _planDeps, planCommand, planDecomposeCommand } from "@/cli";
import { DEFAULT_CONFIG, globalConfigDir, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { _persistPrdDeps } from "@/plan/strategies";
import type { PRD, UserStory } from "@/prd";
import { getContextFiles } from "@/prd";
import { readProjectIdentity } from "@/runtime";
import { gitSpawnEnv } from "@/utils/git-env";

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

  test("preserves an escalated parent's inherited agent on the sub-story", async () => {
    const parent = makeStory({
      id: "US-001",
      routing: {
        complexity: "medium",
        testStrategy: "tdd-simple",
        reasoning: "r",
        agent: "opencode",
        agentProfileId: "claude-default",
        initialAgent: "claude",
        initialProfileId: "claude-default",
      },
    });
    setup(makePrd([parent]), [makeSubStory("US-001-A")]);
    _persistPrdDeps.discoverWorkspacePackages = async () => [];
    _persistPrdDeps.existsSync = () => false;

    await planDecomposeCommand(tmpDir, makeRoutedConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]);
    const sub = written.userStories.find((story: UserStory) => story.id === "US-001-A");
    expect(sub?.routing?.agent).toBe("opencode");
    expect(sub?.routing?.initialAgent).toBe("claude");
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

/**
 * US-004 — planCommand claims the project identity before dispatching plan work.
 *
 * Every `nax plan` entry point routes through planCommand, so one claim at the
 * top of planCommand covers every plan mode. Tests drive planCommand end-to-end
 * (claim → context build → strategy execute) with a mocked runtime and assert
 * the observable claim behaviour:
 *   - projectKey derivation (trimmed config.name, else basename(workdir))
 *   - remoteUrl derivation from `_planDeps.spawnSync` (trimmed or null)
 *   - RUN_NAME_COLLISION propagated, with the plan strategy never invoked
 *   - non-collision claim failures warn-and-proceed
 *   - real identity file writes/updates against the isolated global config dir
 */

const SAMPLE_SPEC = `# Feature: URL Shortener
## Problem
Need a way to shorten URLs.
## Acceptance Criteria
- AC-1: Shorten URL
- AC-2: Redirect to original
`;

const SAMPLE_PRD = {
  project: "auto-detected",
  feature: "url-shortener",
  branchName: "feat/url-shortener",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Shorten URL",
      description: "User can shorten a long URL",
      acceptanceCriteria: ["AC-1: Returns shortened URL"],
      tags: ["feature"],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "Single function, clear output",
      },
    },
  ],
};

interface ClaimCall {
  projectKey: string;
  workdir: string;
  remoteUrl: string | null;
}

describe("planCommand — US-004 project identity claim", () => {
  let tmpDir: string;
  let dispatchCount: number;
  let capturedWrites: Array<[string, string]>;
  /** Claimed identity keys touched this test — removed in afterEach. */
  const claimedKeys = new Set<string>();

  const origReadFile = _planDeps.readFile;
  const origWriteFile = _planDeps.writeFile;
  const origScanSourceRoots = _planDeps.scanSourceRoots;
  const origCreateRuntime = _planDeps.createRuntime;
  const origReadPackageJson = _planDeps.readPackageJson;
  const origSpawnSync = _planDeps.spawnSync;
  const origMkdirp = _planDeps.mkdirp;
  const origExistsSync = _planDeps.existsSync;
  const origClaimProjectIdentity = _planDeps.claimProjectIdentity;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-identity-");
    dispatchCount = 0;
    capturedWrites = [];
    claimedKeys.clear();

    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    _planDeps.readFile = mock(async (path: string) => {
      if (path.endsWith("prd.json")) return JSON.stringify(SAMPLE_PRD);
      return SAMPLE_SPEC;
    });
    _planDeps.writeFile = mock(async (path: string, content: string) => {
      capturedWrites.push([path, content]);
    });
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax") || path.endsWith("prd.json"));
    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "my-project" }));
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createRuntime = mock((_cfg: NaxConfig) =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => {
            dispatchCount += 1;
            return {
              result: {
                success: true,
                exitCode: 0,
                output: JSON.stringify(SAMPLE_PRD),
                rateLimited: false,
                durationMs: 1,
                estimatedCostUsd: 0,
                agentFallbacks: [],
              },
              fallbacks: [],
            };
          },
        }),
      }),
    );
  });

  afterEach(async () => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    _planDeps.claimProjectIdentity = origClaimProjectIdentity;
    for (const key of claimedKeys) {
      await rm(join(globalConfigDir(), key), { recursive: true, force: true });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /** Restore the real runtime claim (preload-isolated global dir) and track the key's cleanup. */
  function useRealClaim(projectKey: string): void {
    _planDeps.claimProjectIdentity = origClaimProjectIdentity;
    claimedKeys.add(projectKey);
  }

  /** Install a recording spy; capture every call while delegating to the given impl. */
  function spyClaim(impl: (projectKey: string, workdir: string, remoteUrl: string | null) => Promise<void>) {
    const calls: ClaimCall[] = [];
    _planDeps.claimProjectIdentity = mock(async (projectKey: string, workdir: string, remoteUrl: string | null) => {
      calls.push({ projectKey, workdir, remoteUrl });
      await impl(projectKey, workdir, remoteUrl);
    });
    return { spy: _planDeps.claimProjectIdentity, calls };
  }

  test("AC-1/AC-2 (US-004): rejects with RUN_NAME_COLLISION and never invokes the plan strategy when the claim targets a different workdir", async () => {
    const projectKey = "ac1-collision";
    useRealClaim(projectKey);
    // Pre-register the key under a DIFFERENT workdir using the real runtime claim.
    await origClaimProjectIdentity(projectKey, "/tmp/some-other-checkout", null);

    const err = await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    }).catch((e) => e);

    assertNaxError(err, "planCommand collision rejection");
    expect(err.code).toBe("RUN_NAME_COLLISION");
    // Strategy execute must never run: no runtime was created, no agent dispatch, no PRD write.
    expect(_planDeps.createRuntime).not.toHaveBeenCalled();
    expect(dispatchCount).toBe(0);
    expect(capturedWrites.length).toBe(0);
  });

  test("AC-3 (US-004): when no identity exists, writes an identity with workdir equal to the workdir argument and invokes the strategy once", async () => {
    const projectKey = "ac3-first-claim";
    useRealClaim(projectKey);

    const result = await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    const identity = await readProjectIdentity(projectKey);
    expect(identity).not.toBeNull();
    expect(identity?.workdir).toBe(tmpDir);
    expect(identity?.name).toBe(projectKey);
    expect(dispatchCount).toBe(1);
    expect(result.outputPath).toBe(join(tmpDir, ".nax", "features", "url-shortener", "prd.json"));
  });

  test("AC-4 (US-004): when the identity is already registered to the same workdir, invokes the strategy once and updates lastSeen", async () => {
    const projectKey = "ac4-reclaim-same";
    useRealClaim(projectKey);
    await origClaimProjectIdentity(projectKey, tmpDir, null);
    const before = await readProjectIdentity(projectKey);
    expect(before?.workdir).toBe(tmpDir);
    // Ensure the clock advances so lastSeen is observably refreshed.
    await new Promise((r) => setTimeout(r, 5));

    await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    const after = await readProjectIdentity(projectKey);
    expect(after?.workdir).toBe(tmpDir);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.lastSeen).not.toBe(before?.lastSeen);
    expect(dispatchCount).toBe(1);
  });

  test("AC-5 (US-004): claims under the trimmed config.name when config.name is a non-empty string", async () => {
    const projectKey = "ac5-trimmed-name";
    const { spy, calls } = spyClaim(async () => {});

    await planCommand(tmpDir, makeConfigWithName(`  ${projectKey}  `), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls[0]?.projectKey).toBe(projectKey); // trimmed — no surrounding whitespace
    expect(calls[0]?.workdir).toBe(tmpDir);
    expect(dispatchCount).toBe(1);
  });

  test("AC-6 (US-004): claims under basename(workdir) when config.name is absent or whitespace-only", async () => {
    const { spy, calls } = spyClaim(async () => {});
    const expectedKey = basename(tmpDir);

    for (const name of ["", "   "]) {
      await planCommand(tmpDir, makeConfigWithName(name), {
        from: join(tmpDir, "spec.md"),
        feature: "url-shortener",
      });
    }

    expect(spy).toHaveBeenCalledTimes(2);
    expect(calls[0]?.projectKey).toBe(expectedKey);
    expect(calls[0]?.workdir).toBe(tmpDir);
    expect(calls[1]?.projectKey).toBe(expectedKey);
    expect(calls[1]?.workdir).toBe(tmpDir);
    expect(dispatchCount).toBe(2);
  });

  test("AC-7 (US-004): passes the trimmed origin remote URL as remoteUrl when spawnSync exits 0", async () => {
    const projectKey = "ac7-remote-url";
    _planDeps.spawnSync = mock(() => ({
      stdout: Buffer.from("  https://github.com/org/repo-name.git\n"),
      exitCode: 0,
    }));
    const { calls } = spyClaim(async () => {});

    await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    expect(_planDeps.spawnSync).toHaveBeenCalledWith(["git", "remote", "get-url", "origin"], {
      cwd: tmpDir,
      env: gitSpawnEnv(),
    });
    expect(calls[0]?.projectKey).toBe(projectKey);
    expect(calls[0]?.workdir).toBe(tmpDir);
    expect(calls[0]?.remoteUrl).toBe("https://github.com/org/repo-name.git"); // trimmed
  });

  test("AC-8 (US-004): passes null as remoteUrl when spawnSync reports a non-zero exit code", async () => {
    const projectKey = "ac8-null-remote";
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 128 }));
    const { calls } = spyClaim(async () => {});

    await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    expect(calls[0]?.projectKey).toBe(projectKey);
    expect(calls[0]?.workdir).toBe(tmpDir);
    expect(calls[0]?.remoteUrl).toBeNull();
    expect(dispatchCount).toBe(1);
  });

  test("AC-9 (US-004): when the claim rejects with a non-RUN_NAME_COLLISION error, invokes the strategy once and resolves", async () => {
    const projectKey = "ac9-warn-proceed";
    const { spy, calls } = spyClaim(async () => {
      throw new NaxError("Disk write failed", "IDENTITY_WRITE_FAILED", { stage: "plan" });
    });

    const result = await planCommand(tmpDir, makeConfigWithName(projectKey), {
      from: join(tmpDir, "spec.md"),
      feature: "url-shortener",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
    expect(dispatchCount).toBe(1);
    expect(result.outputPath).toBe(join(tmpDir, ".nax", "features", "url-shortener", "prd.json"));
  });
});

function makeConfigWithName(name: string): NaxConfig {
  return { ...DEFAULT_CONFIG, name };
}
