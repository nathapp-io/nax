/**
 * Unit tests for planCommand interactive mode (PLN-002)
 *
 * Tests new behavior: interactive ACP session, question/answer routing,
 * JSON extraction from final output, timeout handling.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  assertDefined,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeTempDir,
} from "@test/helpers";
import type { AgentRunOptions } from "@/agents";
import type { DecomposedStory } from "@/agents/shared/types-extended";
import type { CompleteOptions } from "@/agents/types";
import { _planDeps, planCommand } from "@/cli";
import { _planDeps as _deps, planDecomposeCommand } from "@/cli/plan";
import { DEFAULT_CONFIG } from "@/config";
import type { PRD, UserStory } from "@/prd/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockPlanManager(runFn?: (runOptions: AgentRunOptions) => Promise<void>) {
  return makeMockRuntime({
    agentManager: makeMockAgentManager({
      runWithFallbackFn: runFn
        ? async (req) => {
            await runFn(req.runOptions);
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
          }
        : async () => ({
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
          }),
    }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SPEC = `# Feature: URL Shortener
## Problem
Need a way to shorten URLs.
## Acceptance Criteria
- AC-1: Shorten URL
- AC-2: Redirect to original
`;

const SAMPLE_PRD: PRD = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const origReadFile = _deps.readFile;
const origWriteFile = _deps.writeFile;
const origScanSourceRoots = _deps.scanSourceRoots;
const origCreateRuntime = _deps.createRuntime;
const origReadPackageJson = _deps.readPackageJson;
const origReadPackageJsonAt = _deps.readPackageJsonAt;
const origSpawnSync = _deps.spawnSync;
const origMkdirp = _deps.mkdirp;
const origExistsSync = _deps.existsSync;
const origDiscoverWorkspacePackages = _deps.discoverWorkspacePackages;
const origCreateInteractionBridge = _deps.createInteractionBridge;
const origInitInteractionChain = _deps.initInteractionChain;

/** Mock bridge that auto-answers any question with "Yes" — no stdin involved. */
function makeMockBridge(autoAnswer = "Yes") {
  return {
    detectQuestion: mock(async (text: string) => text.includes("?")),
    onQuestionDetected: mock(async (_question: string) => autoAnswer),
  };
}

function _makeFakeScan() {
  return {
    fileTree: "└── src/\n    └── index.ts",
    dependencies: { express: "^4.18.0" },
    devDependencies: { vitest: "^1.0.0" },
    testPatterns: ["Test framework: vitest"],
  };
}

/**
 * Create a mock adapter that simulates interactive ACP session.
 */
// makeInteractiveAdapter removed — replaced by makeMockPlanManager

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planCommand — interactive mode (PLN-002)", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-interactive-test-");
    capturedWriteArgs = [];

    // Create nax directory
    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    // Default deps — override per test as needed
    // readFile: return PRD JSON when reading prd.json (agent wrote it), spec otherwise
    _deps.readFile = mock(async (path: string) =>
      path.endsWith("prd.json") ? JSON.stringify(SAMPLE_PRD) : SAMPLE_SPEC,
    );
    // Simulate agent having written the PRD file (existsSync check passes by default)
    _deps.existsSync = mock((_path: string) => true);

    _deps.writeFile = mock(async (path: string, content: string) => {
      capturedWriteArgs.push([path, content]);
    });

    _deps.scanSourceRoots = mock(async (_workdir: string) => []);

    _deps.readPackageJson = mock(async (_workdir: string) => ({ name: "my-project" }));

    _deps.spawnSync = mock((_cmd: string[], _opts?: object) => ({
      stdout: Buffer.from(""),
      exitCode: 1,
    }));

    _deps.mkdirp = mock(async (_path: string) => {});
    _deps.createInteractionBridge = mock(() => makeMockBridge());
    _deps.initInteractionChain = mock(async () => null);
  });

  afterEach(async () => {
    mock.restore();
    _deps.readFile = origReadFile;
    _deps.writeFile = origWriteFile;
    _deps.scanSourceRoots = origScanSourceRoots;
    _deps.createRuntime = origCreateRuntime;
    _deps.readPackageJson = origReadPackageJson;
    _deps.spawnSync = origSpawnSync;
    _deps.mkdirp = origMkdirp;
    _deps.existsSync = origExistsSync;
    _deps.createInteractionBridge = origCreateInteractionBridge;
    _deps.initInteractionChain = origInitInteractionChain;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-1: Default nax plan (no --auto) starts an interactive ACP session
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-1: default nax plan (no --auto) calls adapter.runAs() for interactive planning", async () => {
    const capturedPlans: unknown[] = [];
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (opts: AgentRunOptions) => {
        capturedPlans.push(opts);
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedPlans.length).toBe(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-2: Agent asks clarifying questions that are forwarded to human
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-2: agent questions are forwarded via interaction bridge", async () => {
    const questionsAsked: string[] = [];
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (opts: AgentRunOptions) => {
        const bridge = opts.interactionBridge;
        if (bridge) {
          const question = "Should URLs expire?";
          questionsAsked.push(question);
          try {
            const answer = await bridge.onQuestionDetected(question);
            questionsAsked.push(`Answer: ${answer}`);
          } catch {
            // Timeout or no interaction
          }
        }
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(questionsAsked.length).toBeGreaterThan(0);
    expect(questionsAsked[0]).toContain("Should");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-3: Human responses are sent as follow-up prompts to same session
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-3: human answers sent as follow-up prompts to session", async () => {
    const prompts: string[] = [];
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (opts: AgentRunOptions) => {
        const bridge = opts.interactionBridge;
        if (bridge) {
          const question = "Should URLs expire?";
          prompts.push(question);
          const answer = await bridge.onQuestionDetected(question);
          prompts.push(answer);
        }
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(prompts.length).toBeGreaterThan(1);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-4: Final output extracted from agent's last message as JSON
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-4: extracts JSON from agent final output wrapped in code block", async () => {
    _deps.createRuntime = mock(() => makeMockPlanManager());

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.userStories).toBeDefined();
    expect(Array.isArray(written.userStories)).toBe(true);
  });

  test("AC-4: throws on invalid JSON in agent output", async () => {
    _deps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => ({
            result: {
              success: true,
              exitCode: 0,
              output: "invalid json {{",
              rateLimited: false,
              durationMs: 1,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
          }),
        }),
      }),
    );
    _deps.existsSync = mock((path: string) => path.endsWith(".nax"));

    await expect(
      planCommand(tmpDir, DEFAULT_CONFIG, {
        from: "/spec.md",
        feature: "url-shortener",
      }),
    ).rejects.toThrow();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-5: Output validated and written to prd.json
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-5: validates output and writes to nax/features/<feature>/prd.json", async () => {
    _deps.createRuntime = mock(() => makeMockPlanManager());

    const result = await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    const expectedPath = join(tmpDir, ".nax", "features", "url-shortener", "prd.json");
    expect(result.outputPath).toBe(expectedPath);
    expect(capturedWriteArgs[0][0]).toBe(expectedPath);

    const [_path, content] = capturedWriteArgs[0];
    const written = JSON.parse(content) as PRD;
    expect(written.feature).toBe("url-shortener");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-6: Planning session respects timeout (default 10 min)
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-6: passes timeout option to adapter.runAs()", async () => {
    let capturedTimeoutSeconds: number | undefined;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (opts: AgentRunOptions) => {
        capturedTimeoutSeconds = opts.timeoutSeconds;
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedTimeoutSeconds).toBe(600);
  });

  test("AC-6: defaults to 10 min timeout if not specified", async () => {
    let capturedTimeoutSeconds: number | undefined;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (opts: AgentRunOptions) => {
        capturedTimeoutSeconds = opts.timeoutSeconds;
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedTimeoutSeconds).toBe(600);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // AC-7: CLI stdin interaction works for local terminal usage
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-7: interaction bridge is provided to adapter for CLI stdin support", async () => {
    let bridgeProvided = false;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (opts: AgentRunOptions) => {
        bridgeProvided = !!opts.interactionBridge;
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(bridgeProvided).toBe(true);
  });

  test("AC-7: interaction bridge has detectQuestion and onQuestionDetected methods", async () => {
    let bridgeHasRequiredMethods = false;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (opts: AgentRunOptions) => {
        const bridge = opts.interactionBridge;
        bridgeHasRequiredMethods =
          typeof bridge?.detectQuestion === "function" && typeof bridge?.onQuestionDetected === "function";
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(bridgeHasRequiredMethods).toBe(true);
  });

  test("AC-8: interactive planning passes sessionRole 'plan' to adapter.runAs()", async () => {
    let capturedSessionRole: string | undefined;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async (opts: AgentRunOptions) => {
        capturedSessionRole = opts.sessionRole;
      }),
    );

    await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(capturedSessionRole).toBe("plan");
  });

  test("continues when interactive plan() errors but prd.json exists", async () => {
    let planCalled = false;
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async () => {
        planCalled = true;
        throw new Error("missing end_turn");
      }),
    );
    _deps.existsSync = mock((path: string) => path.endsWith(".nax") || path.endsWith("prd.json"));
    _deps.readFile = mock(async (path: string) =>
      path.endsWith("prd.json") ? JSON.stringify(SAMPLE_PRD) : SAMPLE_SPEC,
    );

    const result = await planCommand(tmpDir, DEFAULT_CONFIG, {
      from: "/spec.md",
      feature: "url-shortener",
    });

    expect(result.outputPath).toContain("prd.json");
    expect(planCalled).toBe(true);
  });

  test("throws when interactive plan() errors and prd.json is missing", async () => {
    _deps.createRuntime = mock(() =>
      makeMockPlanManager(async () => {
        throw new Error("missing end_turn");
      }),
    );
    _deps.existsSync = mock((path: string) => path.endsWith(".nax"));

    await expect(
      planCommand(tmpDir, DEFAULT_CONFIG, {
        from: "/spec.md",
        feature: "url-shortener",
      }),
    ).rejects.toThrow();
  });
});

/**
 * Unit tests for planDecomposeCommand mapper wiring (US-003 AC-5)
 *
 * Verifies that planDecomposeCommand() uses mapDecomposedStoriesToUserStories()
 * to convert adapter.decompose() output (DecomposedStory[]) to UserStory[] before
 * inserting into the PRD.
 *
 * Split from plan-decompose.test.ts which already exceeds 400 lines.
 */

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

const FEATURE = "test-feature";

function makeParentStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: "US-001",
    title: "Parent story to decompose",
    description: "A complex story needing decomposition",
    acceptanceCriteria: ["AC-1", "AC-2", "AC-3"],
    tags: ["feature"],
    dependencies: [],
    status: "pending",
    passes: false,
    escalations: [],
    attempts: 0,
    contextFiles: ["src/index.ts"],
    routing: {
      complexity: "complex",
      testStrategy: "test-after",
      reasoning: "Too complex for one story",
    },
    ...overrides,
  };
}

function makePrd(stories: UserStory[] = [makeParentStory()]): PRD {
  return makePRD({ feature: FEATURE, branchName: "feat/test-feature", userStories: stories });
}

function makeDecomposedStory(overrides: Partial<DecomposedStory> = {}): DecomposedStory {
  return {
    id: "US-001-A",
    title: "Sub-story A",
    description: "First sub-story",
    acceptanceCriteria: ["AC-1"],
    tags: ["feature"],
    dependencies: [],
    complexity: "simple",
    contextFiles: ["src/feature-a.ts"],
    reasoning: "Simple isolated task",
    estimatedLOC: 30,
    risks: [],
    testStrategy: "test-after",
    ...overrides,
  };
}

function _mapperMakeFakeScan() {
  return {
    fileTree: "└── src/\n    └── index.ts",
    dependencies: {},
    devDependencies: {},
    testPatterns: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: planDecomposeCommand uses mapper (AC-5)
// ─────────────────────────────────────────────────────────────────────────────

describe("planDecomposeCommand — mapper wiring (US-003 AC-5)", () => {
  let tmpDir: string;
  let capturedWriteArgs: Array<[string, string]>;

  function setupDepsWithDecompose(prd: PRD, decomposedStories: DecomposedStory[]) {
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
    _planDeps.readPackageJson = mock(async () => null);
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockDecomposeManager(async (_name: string, _opts: CompleteOptions) => ({
          stories: decomposedStories,
        })),
      }),
    );
  }

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-decompose-mapper-test-");
    capturedWriteArgs = [];
    await mkdir(join(tmpDir, ".nax", "features", FEATURE), { recursive: true });
  });

  afterEach(() => {
    mock.restore();
    _planDeps.existsSync = origExistsSync;
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  test("sub-stories written to PRD have status pending from mapper", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A" }),
      makeDecomposedStory({ id: "US-001-B", complexity: "medium" }),
    ];
    setupDepsWithDecompose(prd, decomposed);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStories = written.userStories.filter((s) => s.parentStoryId === "US-001");
    expect(subStories).toHaveLength(2);
    for (const s of subStories) {
      expect(s.status).toBe("pending");
    }
  });

  test("sub-stories written to PRD have passes false from mapper", async () => {
    const prd = makePrd();
    setupDepsWithDecompose(prd, [makeDecomposedStory({ id: "US-001-A" })]);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStories = written.userStories.filter((s) => s.parentStoryId === "US-001");
    for (const s of subStories) {
      expect(s.passes).toBe(false);
    }
  });

  test("sub-stories written to PRD have escalations empty array from mapper", async () => {
    const prd = makePrd();
    setupDepsWithDecompose(prd, [makeDecomposedStory({ id: "US-001-A" })]);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStories = written.userStories.filter((s) => s.parentStoryId === "US-001");
    for (const s of subStories) {
      expect(s.escalations).toEqual([]);
    }
  });

  test("sub-stories written to PRD have attempts 0 from mapper", async () => {
    const prd = makePrd();
    setupDepsWithDecompose(prd, [makeDecomposedStory({ id: "US-001-A" })]);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const subStories = written.userStories.filter((s) => s.parentStoryId === "US-001");
    for (const s of subStories) {
      expect(s.attempts).toBe(0);
    }
  });

  test("routing.complexity in written PRD matches DecomposedStory.complexity", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A", complexity: "simple" }),
      makeDecomposedStory({ id: "US-001-B", complexity: "expert" }),
    ];
    setupDepsWithDecompose(prd, decomposed);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const storyA = written.userStories.find((s) => s.id === "US-001-A");
    const storyB = written.userStories.find((s) => s.id === "US-001-B");
    expect(storyA?.routing?.complexity).toBe("simple");
    expect(storyB?.routing?.complexity).toBe("expert");
  });

  test("routing.testStrategy in written PRD matches DecomposedStory.testStrategy", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A", testStrategy: "tdd-simple" }),
      makeDecomposedStory({ id: "US-001-B", testStrategy: "three-session-tdd" }),
    ];
    setupDepsWithDecompose(prd, decomposed);

    await planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" });

    const written = JSON.parse(capturedWriteArgs[0][1]) as PRD;
    const storyA = written.userStories.find((s) => s.id === "US-001-A");
    const storyB = written.userStories.find((s) => s.id === "US-001-B");
    expect(storyA?.routing?.testStrategy).toBe("tdd-simple");
    expect(storyB?.routing?.testStrategy).toBe("three-session-tdd");
  });

  test("throws when DecomposedStory has empty id (caught by parseDecomposeOutput)", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A" }),
      makeDecomposedStory({ id: "" }), // invalid — empty id
    ];
    setupDepsWithDecompose(prd, decomposed);

    await expect(
      planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).rejects.toThrow(/index 1/);
  });

  test("succeeds and writes PRD when DecomposedStory has empty contextFiles (warns, does not throw)", async () => {
    const prd = makePrd();
    const decomposed = [
      makeDecomposedStory({ id: "US-001-A", contextFiles: [] }), // empty contextFiles — warns and continues
    ];
    setupDepsWithDecompose(prd, decomposed);

    // Should complete without throwing
    await expect(
      planDecomposeCommand(tmpDir, makeNaxConfig(), { feature: FEATURE, storyId: "US-001" }),
    ).resolves.not.toThrow();
  });
});
