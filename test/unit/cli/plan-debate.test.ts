/**
 * Unit tests — planCommand debate integration (US-004)
 *
 * AC1: When debate.enabled=true and stages.plan.enabled=true,
 *      planCommand uses DebateSession.runPlan() — regardless of auto/interactive mode
 * AC2: When debate.enabled=false, adapter.complete() called exactly once (auto mode)
 * AC6: When all debaters fail (runPlan returns failed), fallback to interactive plan path
 *
 * Design change (Option A, #172 fix):
 *   - Debate is now SSOT: fires whenever debate.enabled + stages.plan.enabled, regardless of mode.
 *   - DebateSession.runPlan() replaces DebateSession.run() for the plan stage.
 *   - Fallback on debate failure uses the interactive plan path (adapter.plan()), not complete().
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { _planDeps, planCommand } from "@/cli";
import type { NaxConfig } from "@/config";
import type { DebateResult } from "@/debate/types";
import type { PRD } from "@/prd/types";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockPlanManager(
  runFn?: (runOptions: any) => Promise<any>,
) {
  return makeMockRuntime({
    agentManager: makeMockAgentManager({
      runWithFallbackFn: runFn
        ? async (req) => { await runFn(req.runOptions); return { result: { success: true, exitCode: 0, output: JSON.stringify(SAMPLE_PRD), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] }; }
        : async () => ({ result: { success: true, exitCode: 0, output: JSON.stringify(SAMPLE_PRD), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] }),
    }),
  });
}

const SAMPLE_SPEC = `# Feature: Debate Integration Test\n## Goal\nTest that debate is wired into plan.\n`;

const SAMPLE_PRD: PRD = {
  project: "test-project",
  feature: "debate-plan",
  branchName: "feat/debate-plan",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  userStories: [
    {
      id: "US-001",
      title: "Debate plan test story",
      description: "Test story for debate integration",
      acceptanceCriteria: ["When debate enabled, use DebateSession"],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      routing: {
        complexity: "simple",
        testStrategy: "test-after",
        reasoning: "simple test",
      },
    },
  ],
};

const DEBATE_PLAN_ENABLED_CONFIG: NaxConfig = {
  debate: {
    enabled: true,
    agents: 2,
    stages: {
      plan: {
        enabled: true,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
        debaters: [
          { agent: "claude" },
          { agent: "opencode" },
        ],
      },
      review: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      acceptance: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      rectification: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      escalation: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    },
  },
} as NaxConfig;

const DEBATE_PLAN_STAGE_DISABLED_CONFIG: NaxConfig = {
  debate: {
    enabled: true,
    agents: 2,
    stages: {
      plan: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      review: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      acceptance: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      rectification: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
      escalation: {
        enabled: false,
        resolver: { type: "majority-fail-closed" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    },
  },
} as NaxConfig;

const DEBATE_PASSED_RESULT: DebateResult = {
  storyId: "debate-plan",
  stage: "plan",
  outcome: "passed",
  output: JSON.stringify(SAMPLE_PRD),
  rounds: 1,
  debaters: ["claude", "opencode"],
  resolverType: "majority-fail-closed",
  proposals: [
    { debater: { agent: "claude" }, output: JSON.stringify(SAMPLE_PRD) },
    { debater: { agent: "opencode" }, output: JSON.stringify(SAMPLE_PRD) },
  ],
  totalCostUsd: 0.001,
};

const DEBATE_FAILED_RESULT: DebateResult = {
  storyId: "debate-plan",
  stage: "plan",
  outcome: "failed",
  output: "",
  rounds: 0,
  debaters: [],
  resolverType: "majority-fail-closed",
  proposals: [],
  totalCostUsd: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration in afterEach
// ─────────────────────────────────────────────────────────────────────────────

const origReadFile = _planDeps.readFile;
const origWriteFile = _planDeps.writeFile;
const origScanSourceRoots = _planDeps.scanSourceRoots;
const origCreateRuntime = _planDeps.createRuntime;
const origReadPackageJson = _planDeps.readPackageJson;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;
const origExistsSync = _planDeps.existsSync;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origCreateDebateSession = _planDeps.createDebateRunner;
const origInitInteractionChain = _planDeps.initInteractionChain;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Set up mocks for a successful interactive plan (callOp + planInteractiveOp path) */
function setupInteractivePlanMocks(
  runFn: (_runOptions: any) => Promise<any>,
) {
  _planDeps.createRuntime = mock(() => makeMockPlanManager(runFn));
  _planDeps.existsSync = mock((p: string) => p.includes(".nax"));
  _planDeps.readFile = mock(async () => JSON.stringify(SAMPLE_PRD));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("planCommand — debate integration (US-004)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-plan-debate-");
    await mkdir(join(tmpDir, ".nax"), { recursive: true });

    _planDeps.readFile = mock(async () => SAMPLE_SPEC);
    _planDeps.writeFile = mock(async () => {});
    _planDeps.scanSourceRoots = mock(async () => []);
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.existsSync = mock((path: string) => path.endsWith(".nax"));
    _planDeps.initInteractionChain = mock(async () => null);
    _planDeps.createRuntime = mock(() => makeMockPlanManager());
    _planDeps.createDebateRunner = origCreateDebateSession;
  });

  afterEach(() => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanSourceRoots = origScanSourceRoots;
    _planDeps.createRuntime = origCreateRuntime;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.createDebateRunner = origCreateDebateSession;
    _planDeps.initInteractionChain = origInitInteractionChain;
    cleanupTempDir(tmpDir);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC1: debate.enabled=true + stages.plan.enabled=true → DebateSession.runPlan() used
  // ─────────────────────────────────────────────────────────────────────────

  test("AC1: createDebateRunner is called when debate.enabled=true and stages.plan.enabled=true", async () => {
    const runPlanMock = mock(async () => DEBATE_PASSED_RESULT);
    _planDeps.createDebateRunner = mock(() => ({ runPlan: runPlanMock }));

    await planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
      from: "/spec.md",
      feature: "debate-plan",
      auto: true,
    });

    expect(_planDeps.createDebateRunner).toHaveBeenCalled();
  });

  test("AC1: DebateSession.runPlan() is called with the planning prompt and options", async () => {
    const runPlanMock = mock(async () => DEBATE_PASSED_RESULT);
    _planDeps.createDebateRunner = mock(() => ({ runPlan: runPlanMock }));

    await planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
      from: "/spec.md",
      feature: "debate-plan",
      auto: true,
    });

    expect(runPlanMock).toHaveBeenCalledTimes(1);
    const [taskContextArg, outputFormatArg, optsArg] = runPlanMock.mock.calls[0];
    expect(typeof taskContextArg).toBe("string");
    expect(taskContextArg.length).toBeGreaterThan(100);
    expect(typeof outputFormatArg).toBe("string");
    expect(outputFormatArg).toContain("Output Schema");
    expect(optsArg.feature).toBe("debate-plan");
    expect(optsArg.workdir).toBe(tmpDir);
  });

  test("AC1: createDebateRunner receives the plan stage config", async () => {
    const runPlanMock = mock(async () => DEBATE_PASSED_RESULT);
    const createMock = mock(() => ({ runPlan: runPlanMock }));
    _planDeps.createDebateRunner = createMock;

    await planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
      from: "/spec.md",
      feature: "debate-plan",
      auto: true,
    });

    const [opts] = createMock.mock.calls[0];
    expect(opts.stage).toBe("plan");
    expect(opts.stageConfig.enabled).toBe(true);
  });

  test("AC1: adapter.complete() is NOT called when debate is enabled and succeeds", async () => {
    const adapterComplete = mock(async () => JSON.stringify(SAMPLE_PRD));
    _planDeps.createRuntime = mock(() =>
      makeMockPlanManager(
        undefined,
        async (_name: string, _prompt: string, _opts: any) => { adapterComplete(); return { output: JSON.stringify(SAMPLE_PRD), tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 }; },
      ),
    );

    _planDeps.createDebateRunner = mock(() => ({
      runPlan: mock(async () => DEBATE_PASSED_RESULT),
    }));

    await planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
      from: "/spec.md",
      feature: "debate-plan",
      auto: true,
    });

    expect(adapterComplete).not.toHaveBeenCalled();
  });

  test("AC1: debate fires in interactive mode (no --auto flag) when debate.enabled=true", async () => {
    const runPlanMock = mock(async () => DEBATE_PASSED_RESULT);
    _planDeps.createDebateRunner = mock(() => ({ runPlan: runPlanMock }));
    // No auto: true — interactive mode
    await planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
      from: "/spec.md",
      feature: "debate-plan",
    });

    expect(runPlanMock).toHaveBeenCalledTimes(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC2: debate disabled → adapter.plan() called exactly once (ACP auto path), no debate
  // ─────────────────────────────────────────────────────────────────────────

  test("AC2: adapter.complete() called exactly once when debate.enabled=false", async () => {
    const runWithFallbackCalls: string[] = [];
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => {
            runWithFallbackCalls.push("called");
            return { result: { success: true, exitCode: 0, output: JSON.stringify(SAMPLE_PRD), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
          },
        }),
      }),
    );

    const createDebateMock = mock(() => ({ runPlan: mock(async () => DEBATE_PASSED_RESULT) }));
    _planDeps.createDebateRunner = createDebateMock;

    await planCommand(
      tmpDir,
      makeNaxConfig({ debate: { enabled: false } } as any),
      { from: "/spec.md", feature: "debate-plan", auto: true },
    );

    expect(runWithFallbackCalls).toHaveLength(1);
    expect(createDebateMock).not.toHaveBeenCalled();
  });

  test("AC2: adapter.complete() called exactly once when debate config is absent", async () => {
    const runWithFallbackCalls: string[] = [];
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => {
            runWithFallbackCalls.push("called");
            return { result: { success: true, exitCode: 0, output: JSON.stringify(SAMPLE_PRD), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
          },
        }),
      }),
    );

    const createDebateMock = mock(() => ({ runPlan: mock(async () => DEBATE_PASSED_RESULT) }));
    _planDeps.createDebateRunner = createDebateMock;

    await planCommand(tmpDir, makeNaxConfig(), {
      from: "/spec.md",
      feature: "debate-plan",
      auto: true,
    });

    expect(runWithFallbackCalls).toHaveLength(1);
    expect(createDebateMock).not.toHaveBeenCalled();
  });

  test("AC2: adapter.complete() called when debate.stages.plan.enabled=false", async () => {
    const runWithFallbackCalls: string[] = [];
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => {
            runWithFallbackCalls.push("called");
            return { result: { success: true, exitCode: 0, output: JSON.stringify(SAMPLE_PRD), rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] };
          },
        }),
      }),
    );

    const createDebateMock = mock(() => ({ runPlan: mock(async () => DEBATE_PASSED_RESULT) }));
    _planDeps.createDebateRunner = createDebateMock;

    await planCommand(
      tmpDir,
      { ...makeNaxConfig(), ...DEBATE_PLAN_STAGE_DISABLED_CONFIG },
      { from: "/spec.md", feature: "debate-plan", auto: true },
    );

    expect(runWithFallbackCalls).toHaveLength(1);
    expect(createDebateMock).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC6: all debaters fail → fallback to interactive plan path (adapter.runAs())
  // ─────────────────────────────────────────────────────────────────────────

  test("AC6: falls back to interactive plan path when DebateSession returns outcome=failed", async () => {
    const adapterPlan = mock(async () => {});
    setupInteractivePlanMocks(async (_runOptions: any) => { adapterPlan(); });

    _planDeps.createDebateRunner = mock(() => ({
      runPlan: mock(async () => DEBATE_FAILED_RESULT),
    }));

    await planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
      from: "/spec.md",
      feature: "debate-plan",
    });

    expect(adapterPlan).toHaveBeenCalledTimes(1);
  });

  test("AC6: planCommand succeeds (does not throw) when debate fails and fallback is used", async () => {
    const adapterPlan = mock(async () => {});
    setupInteractivePlanMocks(async (_runOptions: any) => { adapterPlan(); });

    _planDeps.createDebateRunner = mock(() => ({
      runPlan: mock(async () => DEBATE_FAILED_RESULT),
    }));

    await expect(
      planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
        from: "/spec.md",
        feature: "debate-plan",
      }),
    ).resolves.toBeDefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Bug[line-214]: silent catch block in debate fallback recovery path
  // swallows validatePlanOutput errors — error must propagate, not be
  // silently discarded while returning an unvalidated outputPath.
  // ─────────────────────────────────────────────────────────────────────────

  test("BUG[214]: propagates validatePlanOutput error from debate-fallback disk recovery instead of silently returning outputPath", async () => {
    // Scenario:
    //   1. debate.runPlan returns outcome=failed → fallback callOp is invoked
    //   2. fallback callOp fails (agent throws) → catch(err) block entered
    //   3. _planDeps.existsSync(outputPath) → true → disk-recovery branch entered
    //   4. readFile(outputPath) returns corrupt/invalid content
    //   5. validatePlanOutput throws a schema error
    //
    // Spec-correct: the schema error must propagate out of planCommand.
    // Current bug (line 214): catch {} swallows it; planCommand returns
    // outputPath as if the PRD on disk were valid — silent contract violation.

    // Debate always fails so the fallback callOp path is exercised.
    _planDeps.createDebateRunner = mock(() => ({
      runPlan: mock(async () => DEBATE_FAILED_RESULT),
    }));

    // Force the fallback callOp to throw so the catch(err) recovery block is entered.
    _planDeps.createRuntime = mock(() =>
      makeMockRuntime({
        agentManager: makeMockAgentManager({
          runWithFallbackFn: async () => {
            throw new Error("fallback-agent-failed-forcing-recovery-path");
          },
        }),
      }),
    );

    // readFile: spec file returns fine; prd.json at outputPath holds corrupt
    // content that will cause validatePlanOutput to throw a schema error.
    _planDeps.readFile = mock(async (path: string) => {
      if (path.endsWith("prd.json")) return "CORRUPT_CONTENT_NOT_VALID_JSON";
      return SAMPLE_SPEC;
    });

    // existsSync → true so disk-recovery is attempted (not short-circuited).
    _planDeps.existsSync = mock(() => true);

    // Spec-correct behaviour: validatePlanOutput throws, so planCommand must
    // propagate the error.  With the current bug planCommand swallows it and
    // resolves with outputPath — a silent contract violation.
    let caughtError: unknown;
    try {
      await planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
        from: "/spec.md",
        feature: "debate-plan",
      });
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeDefined();
  });
});
