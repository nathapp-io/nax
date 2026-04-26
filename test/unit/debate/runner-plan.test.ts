import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DebateRunner } from "../../../src/debate/runner";
import { _debateSessionDeps } from "../../../src/debate/session-helpers";
import type { DebateStageConfig } from "../../../src/debate/types";
import type { CallContext } from "../../../src/operations/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { makeMockAgentManager, makeSessionManager } from "../../helpers";

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager();
  return {
    runtime: {
      agentManager,
      sessionManager: makeSessionManager(),
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-020",
    featureName: "feat-plan",
    ...overrides,
  };
}

function makePlanStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "one-shot",
    mode: "panel",
    rounds: 1,
    debaters: [
      { agent: "claude", model: "fast" },
      { agent: "opencode", model: "fast" },
    ],
    ...overrides,
  };
}

let origGetSafeLogger: typeof _debateSessionDeps.getSafeLogger;
let origReadFile: typeof _debateSessionDeps.readFile;

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  origReadFile = _debateSessionDeps.readFile;
  _debateSessionDeps.getSafeLogger = mock(() => ({
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }));
  _debateSessionDeps.readFile = mock(async (_path: string) => '{"plan": "output"}');
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  _debateSessionDeps.readFile = origReadFile;
  mock.restore();
});

describe("DebateRunner.runPlan() — plan mode uses sessionManager.runInSession", () => {
  test("plan mode calls sessionManager.runInSession (not agentManager.planAs)", async () => {
    const runInSessionCalls: Array<{ name: string; prompt: string }> = [];
    const planAsCalls: string[] = [];

    const sm = makeSessionManager({
      runInSession: mock(async (name: string, prompt: string, _opts: unknown) => {
        runInSessionCalls.push({ name, prompt });
        return {
          output: "plan output",
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          internalRoundTrips: 1,
        };
      }) as any,
      nameFor: mock((_req: unknown) => "nax-test-session"),
    });

    const agentManager = makeMockAgentManager({
      planAsFn: async (agentName) => {
        planAsCalls.push(agentName);
        return { specContent: "plan content" };
      },
    });

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    // sessionManager.runInSession should be called per debater
    expect(runInSessionCalls.length).toBeGreaterThan(0);
    // planAs should NOT be called in the migrated implementation
    expect(planAsCalls.length).toBe(0);
  });

  test("planAs is not called — verify mock never invoked", async () => {
    const planAsMock = mock(async () => ({ specContent: "from planAs" }));

    const sm = makeSessionManager({
      runInSession: mock(async (_name: string, _prompt: string, _opts: unknown) => ({
        output: "plan output",
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        internalRoundTrips: 1,
      })) as any,
      nameFor: mock((_req: unknown) => "nax-mock-session"),
    });

    const agentManager = makeMockAgentManager({
      planAsFn: planAsMock as any,
    });

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    await runner.runPlan("task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    expect(planAsMock).not.toHaveBeenCalled();
  });

  test("runPlan() returns a DebateResult", async () => {
    const sm = makeSessionManager({
      runInSession: mock(async (_name: string, _prompt: string, _opts: unknown) => ({
        output: "plan output",
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        internalRoundTrips: 1,
      })) as any,
      nameFor: mock((_req: unknown) => "nax-result-session"),
    });

    const agentManager = makeMockAgentManager();

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    // Should return a valid DebateResult shape
    expect(result).toHaveProperty("outcome");
    expect(result).toHaveProperty("stage");
    expect(result).toHaveProperty("storyId");
    expect(result).toHaveProperty("proposals");
    expect(result.stage).toBe("plan");
  });

  test("runPlan() returns failed when sessionManager is missing", async () => {
    const agentManager = makeMockAgentManager();

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: undefined as any,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "plan",
      stageConfig: makePlanStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: undefined,
    });

    // Each debater throws internally (no sessionManager) but allSettledBounded catches it
    // and all debaters fail → buildFailedResult → outcome: "failed"
    const result = await runner.runPlan("task context", "output format", {
      workdir: "/tmp/work",
      feature: "feat-plan",
      outputDir: "/tmp/out",
    });

    expect(result.outcome).toBe("failed");
  });
});
