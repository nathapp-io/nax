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
import { _planDeps, planCommand } from "../../../src/cli/plan";
import type { DebateResult } from "../../../src/debate/types";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";
import { makeMockAgentManager, makeNaxConfig } from "../../helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockPlanManager(
  planFn?: (agentName: string, opts: any) => Promise<{ specContent: string }>,
  completeFn?: (name: string, prompt: string, opts: any) => Promise<{ output: string; costUsd: number; source: "exact" | "estimated" | "fallback" }>,
) {
  return makeMockAgentManager({
    planAsFn: planFn ? async (name: string, opts: any) => planFn(name, opts) : undefined,
    completeAsFn: completeFn,
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
const origScanCodebase = _planDeps.scanCodebase;
const origCreateManager = _planDeps.createManager;
const origReadPackageJson = _planDeps.readPackageJson;
const origSpawnSync = _planDeps.spawnSync;
const origMkdirp = _planDeps.mkdirp;
const origExistsSync = _planDeps.existsSync;
const origDiscoverWorkspacePackages = _planDeps.discoverWorkspacePackages;
const origReadPackageJsonAt = _planDeps.readPackageJsonAt;
const origCreateDebateSession = _planDeps.createDebateSession;
const origInitInteractionChain = _planDeps.initInteractionChain;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Set up mocks for a successful interactive plan (adapter.plan() path) */
function setupInteractivePlanMocks(
  planFn: (name: string, opts: any) => Promise<{ specContent: string }>,
) {
  _planDeps.createManager = mock(() =>
    makeMockPlanManager(planFn, undefined),
  );
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
    _planDeps.scanCodebase = mock(async () => ({
      fileTree: "└── src/",
      dependencies: {},
      devDependencies: {},
      testPatterns: [],
    }));
    _planDeps.readPackageJson = mock(async () => ({ name: "test-project" }));
    _planDeps.readPackageJsonAt = mock(async () => null);
    _planDeps.spawnSync = mock(() => ({ stdout: Buffer.from(""), exitCode: 1 }));
    _planDeps.mkdirp = mock(async () => {});
    _planDeps.discoverWorkspacePackages = mock(async () => []);
    _planDeps.existsSync = mock(() => false);
    _planDeps.initInteractionChain = mock(async () => null);
    _planDeps.createManager = mock(() =>
      makeMockPlanManager(
        undefined,
        async (_name: string, _prompt: string, _opts: any) => ({ output: JSON.stringify(SAMPLE_PRD), costUsd: 0, source: "exact" as const }),
      ),
    );
    _planDeps.createDebateSession = origCreateDebateSession;
  });

  afterEach(() => {
    mock.restore();
    _planDeps.readFile = origReadFile;
    _planDeps.writeFile = origWriteFile;
    _planDeps.scanCodebase = origScanCodebase;
    _planDeps.createManager = origCreateManager;
    _planDeps.readPackageJson = origReadPackageJson;
    _planDeps.spawnSync = origSpawnSync;
    _planDeps.mkdirp = origMkdirp;
    _planDeps.existsSync = origExistsSync;
    _planDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
    _planDeps.readPackageJsonAt = origReadPackageJsonAt;
    _planDeps.createDebateSession = origCreateDebateSession;
    _planDeps.initInteractionChain = origInitInteractionChain;
    cleanupTempDir(tmpDir);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC1: debate.enabled=true + stages.plan.enabled=true → DebateSession.runPlan() used
  // ─────────────────────────────────────────────────────────────────────────

  test("AC1: createDebateSession is called when debate.enabled=true and stages.plan.enabled=true", async () => {
    const runPlanMock = mock(async () => DEBATE_PASSED_RESULT);
    _planDeps.createDebateSession = mock(() => ({ runPlan: runPlanMock }));

    await planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
      from: "/spec.md",
      feature: "debate-plan",
      auto: true,
    });

    expect(_planDeps.createDebateSession).toHaveBeenCalled();
  });

  test("AC1: DebateSession.runPlan() is called with the planning prompt and options", async () => {
    const runPlanMock = mock(async () => DEBATE_PASSED_RESULT);
    _planDeps.createDebateSession = mock(() => ({ runPlan: runPlanMock }));

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

  test("AC1: createDebateSession receives the plan stage config", async () => {
    const runPlanMock = mock(async () => DEBATE_PASSED_RESULT);
    const createMock = mock(() => ({ runPlan: runPlanMock }));
    _planDeps.createDebateSession = createMock;

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
    _planDeps.createManager = mock(() =>
      makeMockPlanManager(
        undefined,
        async (_name: string, _prompt: string, _opts: any) => { adapterComplete(); return { output: JSON.stringify(SAMPLE_PRD), costUsd: 0, source: "exact" as const }; },
      ),
    );

    _planDeps.createDebateSession = mock(() => ({
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
    _planDeps.createDebateSession = mock(() => ({ runPlan: runPlanMock }));
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
    const completeCalls: string[] = [];
    _planDeps.createManager = mock(() =>
      makeMockPlanManager(undefined, async (_name, _prompt, _opts) => {
        completeCalls.push("called");
        return { output: JSON.stringify(SAMPLE_PRD), costUsd: 0, source: "exact" as const };
      }),
    );
    _planDeps.existsSync = mock(() => true);
    _planDeps.readFile = mock(async (p: string) =>
      p.endsWith("prd.json") ? JSON.stringify(SAMPLE_PRD) : SAMPLE_SPEC,
    );

    const createDebateMock = mock(() => ({ runPlan: mock(async () => DEBATE_PASSED_RESULT) }));
    _planDeps.createDebateSession = createDebateMock;

    await planCommand(
      tmpDir,
      makeNaxConfig({ debate: { enabled: false } } as any),
      { from: "/spec.md", feature: "debate-plan", auto: true },
    );

    expect(completeCalls).toHaveLength(1);
    expect(createDebateMock).not.toHaveBeenCalled();
  });

  test("AC2: adapter.complete() called exactly once when debate config is absent", async () => {
    const completeCalls: string[] = [];
    _planDeps.createManager = mock(() =>
      makeMockPlanManager(undefined, async (_name, _prompt, _opts) => {
        completeCalls.push("called");
        return { output: JSON.stringify(SAMPLE_PRD), costUsd: 0, source: "exact" as const };
      }),
    );
    _planDeps.existsSync = mock(() => true);
    _planDeps.readFile = mock(async (p: string) =>
      p.endsWith("prd.json") ? JSON.stringify(SAMPLE_PRD) : SAMPLE_SPEC,
    );

    const createDebateMock = mock(() => ({ runPlan: mock(async () => DEBATE_PASSED_RESULT) }));
    _planDeps.createDebateSession = createDebateMock;

    await planCommand(tmpDir, makeNaxConfig(), {
      from: "/spec.md",
      feature: "debate-plan",
      auto: true,
    });

    expect(completeCalls).toHaveLength(1);
    expect(createDebateMock).not.toHaveBeenCalled();
  });

  test("AC2: adapter.complete() called when debate.stages.plan.enabled=false", async () => {
    const completeCalls: string[] = [];
    _planDeps.createManager = mock(() =>
      makeMockPlanManager(undefined, async (_name, _prompt, _opts) => {
        completeCalls.push("called");
        return { output: JSON.stringify(SAMPLE_PRD), costUsd: 0, source: "exact" as const };
      }),
    );
    _planDeps.existsSync = mock(() => true);
    _planDeps.readFile = mock(async (p: string) =>
      p.endsWith("prd.json") ? JSON.stringify(SAMPLE_PRD) : SAMPLE_SPEC,
    );

    const createDebateMock = mock(() => ({ runPlan: mock(async () => DEBATE_PASSED_RESULT) }));
    _planDeps.createDebateSession = createDebateMock;

    await planCommand(
      tmpDir,
      { ...makeNaxConfig(), ...DEBATE_PLAN_STAGE_DISABLED_CONFIG },
      { from: "/spec.md", feature: "debate-plan", auto: true },
    );

    expect(completeCalls).toHaveLength(1);
    expect(createDebateMock).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC6: all debaters fail → fallback to interactive plan path (adapter.plan())
  // ─────────────────────────────────────────────────────────────────────────

  test("AC6: falls back to interactive plan path when DebateSession returns outcome=failed", async () => {
    const adapterPlan = mock(async () => {});
    setupInteractivePlanMocks(async (_name: string, _opts: any) => { adapterPlan(); return { specContent: "" }; });

    _planDeps.createDebateSession = mock(() => ({
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
    setupInteractivePlanMocks(async (_name: string, _opts: any) => { adapterPlan(); return { specContent: "" }; });

    _planDeps.createDebateSession = mock(() => ({
      runPlan: mock(async () => DEBATE_FAILED_RESULT),
    }));

    await expect(
      planCommand(tmpDir, DEBATE_PLAN_ENABLED_CONFIG, {
        from: "/spec.md",
        feature: "debate-plan",
      }),
    ).resolves.toBeDefined();
  });
});
