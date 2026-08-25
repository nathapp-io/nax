import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { computeAcpHandle } from "@/agents/acp/adapter";
import { DEFAULT_CONFIG } from "@/config";
import { DebateRunner } from "@/debate/runner";
import { _statefulDeps } from "@/debate/runner-stateful-helpers";
import { _synthesisDeps } from "@/debate/selectors/synthesis";
import { _debateSessionDeps } from "@/debate/session-helpers";
import type { DebateStageConfig } from "@/debate/types";
import type { CallContext } from "@/operations/types";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import { makeLogger, makeMockAgentManager, makeSessionManager, withDepsRestore } from "@test/helpers";

function installCallOp(impl: typeof _statefulDeps.callOp) {
  const spy = mock(impl);
  _statefulDeps.callOp = spy;
  return spy;
}

// `SuccessfulProposal` deliberately carries no session `handle`. A compile-time
// check for one used to live here, asserting a field `src/debate/session-helpers.ts`
// has never declared and no producer sets — the session handle is held inside the
// stateful debater op and never surfaced on a proposal. It is a prerequisite of the
// unimplemented verifier-pick patch step (see the AC 6 todos in
// `test/unit/debate/selectors/verifier-pick.test.ts`), not of anything shipped.

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager({
    runAsSessionFn: async (_name, _handle, _prompt) => ({
      output: "stateful-output",
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
      estimatedCostUsd: 0,
      internalRoundTrips: 1,
    }),
  });
  return {
    runtime: {
      agentManager,
      sessionManager: makeSessionManager({
        openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
        closeSession: mock(async () => {}),
      }),
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
      costAggregator: createNoOpCostAggregator(),
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-010",
    featureName: "feat-stateful",
    ...overrides,
  };
}

function makeCallCtxWithIds(
  storyId: string,
  agentManager: ReturnType<typeof makeMockAgentManager>,
  sessionManager: ReturnType<typeof makeSessionManager>,
  workdir = "/tmp/work",
): CallContext {
  return {
    runtime: {
      agentManager,
      sessionManager,
      configLoader: { current: () => DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
      packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG }) } as any,
      signal: undefined,
      costAggregator: createNoOpCostAggregator(),
    } as any,
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG } as any,
    packageDir: workdir,
    agentName: "claude",
    storyId,
    featureName: "test",
  };
}

function makeStatefulStageConfig(overrides: Partial<DebateStageConfig> = {}): DebateStageConfig {
  return {
    enabled: true,
    resolver: { type: "majority-fail-closed" },
    sessionMode: "stateful",
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

beforeEach(() => {
  origGetSafeLogger = _debateSessionDeps.getSafeLogger;
  _debateSessionDeps.getSafeLogger = mock(() => makeLogger());
});

afterEach(() => {
  _debateSessionDeps.getSafeLogger = origGetSafeLogger;
  mock.restore();
});

// ─── Stateful mode core tests ─────────────────────────────────────────────────

describe("DebateRunner.run() — stateful mode", () => {
  test("stateful mode calls sessionManager.openSession per debater", async () => {
    const openSessionCalls: string[] = [];
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => {
        openSessionCalls.push(name);
        return { id: name, agentName: "claude" };
      }),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, _handle, _prompt) => ({
        output: "proposal-output",
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      }),
    });

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    await runner.run("stateful prompt");

    expect(openSessionCalls.length).toBe(2);
  });

  test("stateful mode calls agentManager.runAsSession (not completeAs) for debaters", async () => {
    const runAsSessionCalls: string[] = [];
    const completeAsCalls: string[] = [];

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, _prompt) => {
        runAsSessionCalls.push(agentName);
        return {
          output: "session-output",
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
        };
      },
      completeAsFn: async (name) => {
        completeAsCalls.push(name);
        return { output: "complete-output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    await runner.run("stateful prompt");

    expect(runAsSessionCalls.length).toBeGreaterThan(0);
    expect(completeAsCalls.length).toBe(0);
  });

  test("both debaters succeed → outcome resolved", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (_agentName, _handle, _prompt) => ({
        output: '{"passed":true}',
        tokenUsage: { inputTokens: 10, outputTokens: 20 },
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
      }),
    });

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    const result = await runner.run("stateful prompt");

    expect(result.outcome).toBe("passed");
    expect(result.stage).toBe("review");
    expect(result.storyId).toBe("US-010");
  });

  test("single debater fallback when one session fails → outcome passed", async () => {
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, _prompt) => {
        if (agentName === "opencode") {
          throw new Error("opencode session failed");
        }
        return {
          output: `proposal from ${agentName}`,
          tokenUsage: { inputTokens: 10, outputTokens: 20 },
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
        };
      },
    });

    const ctx = makeCallCtx({
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: () => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: createNoOpCostAggregator(),
      } as any,
    });

    const runner = new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: sm,
    });

    const result = await runner.run("stateful prompt");

    expect(result.outcome).toBe("passed");
    expect(result.debaters).toHaveLength(1);
    expect(result.debaters[0]).toBe("claude");
  });
});

// ─── Stateful SSOT tests (from session-stateful) ─────────────────────────────

describe("DebateRunner.run() — stateful mode uses runAsSession SSOT", () => {
  withDepsRestore(_statefulDeps);

  test("proposal round calls runAsSession for each debater", async () => {
    const runAsSessionCalls: Array<{ agentName: string; prompt: string; handleId: string }> = [];

    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, handle, prompt) => {
        runAsSessionCalls.push({ agentName, prompt, handleId: handle.id });
        return {
          output: `proposal-${agentName}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("US-003", agentManager, mockSM),
      stage: "plan",
      stageConfig: makeStatefulStageConfig({ rounds: 1 }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-a",
      timeoutSeconds: 120,
      sessionManager: mockSM,
    });

    await runner.run("test prompt");

    expect(runAsSessionCalls.length).toBe(2);
    expect(runAsSessionCalls[0].agentName).toBe("claude");
    expect(runAsSessionCalls[1].agentName).toBe("opencode");
  });

  test("rounds > 1: critique runs on same session handle as proposal", async () => {
    const roleCallMap = new Map<string, string[]>();
    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });
    const agentManager = makeMockAgentManager();

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("US-004", agentManager, mockSM),
      stage: "review",
      stageConfig: makeStatefulStageConfig({ rounds: 2 }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-b",
      timeoutSeconds: 120,
      sessionManager: mockSM,
    });

    installCallOp(async (callCtx, _op, input) => {
      const role = callCtx.sessionOverride?.role ?? "";
      const kind = input.proposePrompt.includes("reviewing proposals") ? "critique" : "proposal";
      const calls = roleCallMap.get(role) ?? [];
      calls.push(kind);
      roleCallMap.set(role, calls);

      input.proposalBarriers[0]?.resolve("ok");
      return { success: true, rebut: "ok" };
    });

    await runner.run("review prompt");

    for (const calls of roleCallMap.values()) {
      expect(calls).toContain("proposal");
      expect(calls).toContain("critique");
    }
    expect(roleCallMap.get("debate-review-0")).toEqual(["proposal", "critique"]);
    expect(roleCallMap.get("debate-review-1")).toEqual(["proposal", "critique"]);
  });

  test("falls back to single-agent passed when only one proposal run succeeds", async () => {
    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({
        id: name,
        agentName: name.includes("opencode") ? "opencode" : "claude",
      })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async (agentName, _handle, _prompt) => {
        if (agentName === "opencode") throw new Error("opencode failed");
        return {
          output: `proposal-${agentName}`,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("US-005", agentManager, mockSM),
      stage: "review",
      stageConfig: makeStatefulStageConfig({ rounds: 2 }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-c",
      sessionManager: mockSM,
    });

    const result = await runner.run("review prompt");
    expect(result.outcome).toBe("passed");
    expect(result.debaters).toEqual(["claude"]);
  });
});

// ─── resolveOutcome with computeAcpHandle ────────────────────────────────────

describe("runStateful() — resolveOutcome receives workdir and featureName (US-004 AC4)", () => {
  withDepsRestore(_statefulDeps);
  withDepsRestore(_synthesisDeps);

  test("synthesis resolver receives sessionName built from ctx.workdir and ctx.featureName", async () => {
    const mockSM = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: '{"passed": true}',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      }),
    });

    const workdir = "/tmp/stateful-work";
    const featureName = "stateful-feature";
    const storyId = "US-004-stateful";

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds(storyId, agentManager, mockSM, workdir),
      stage: "review",
      stageConfig: makeStatefulStageConfig({ resolver: { type: "synthesis" }, rounds: 1 }),
      config: DEFAULT_CONFIG,
      workdir,
      featureName,
      timeoutSeconds: 60,
      sessionManager: mockSM,
    });

    const resolverCalls: Array<{ workdir: string; featureName: string; role?: string }> = [];
    installCallOp(async (_callCtx, _op, input) => {
      input.proposalBarriers[0]?.resolve('{"passed": true}');
      return { success: true, rebut: '{"passed": true}' };
    });
    _synthesisDeps.callOp = mock(async (callCtx) => {
      resolverCalls.push({
        workdir: callCtx.packageDir,
        featureName: callCtx.featureName ?? "",
        role: callCtx.sessionOverride?.role,
      });
      return "synthesis resolved";
    });

    await runner.run("review prompt");

    const synthesisCall = resolverCalls[0];
    expect(synthesisCall).toBeDefined();
    const expectedSessionName = computeAcpHandle(workdir, featureName, storyId, "synthesis");
    expect(computeAcpHandle(synthesisCall?.workdir ?? "", synthesisCall?.featureName ?? "", storyId, "synthesis")).toBe(
      expectedSessionName,
    );
    expect(synthesisCall?.role).toBe("synthesis");
  });
});

// ─── One-shot mode unchanged ──────────────────────────────────────────────────

describe("DebateRunner.run() — one-shot mode unchanged", () => {
  test("one-shot does not use runAsSession for proposal path", async () => {
    let runAsSessionCount = 0;
    let completeCount = 0;

    const mockSM = makeSessionManager();
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => {
        runAsSessionCount += 1;
        return {
          output: "run-session",
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0,
          internalRoundTrips: 0,
        };
      },
      completeFn: async () => {
        completeCount += 1;
        return {
          output: '{"passed": true}',
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          estimatedCostUsd: 0.1,
          exactCostUsd: 0.1,
        };
      },
    });

    const runner = new DebateRunner({
      ctx: makeCallCtxWithIds("US-006", agentManager, mockSM),
      stage: "plan",
      stageConfig: makeStatefulStageConfig({ sessionMode: "one-shot", rounds: 1 }),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      featureName: "feat-d",
    });

    await runner.run("plan prompt");

    expect(runAsSessionCount).toBe(0);
    expect(completeCount).toBeGreaterThan(0);
  });
});

// ─── US-005: Two-scope cost tracking ─────────────────────────────────────────

describe("runStateful() — two-scope cost tracking (US-005)", () => {
  withDepsRestore(_statefulDeps);

  function makeScopedCostAgg(debaterCost = 0, resolverCost = 0) {
    let callCount = 0;
    const closed: string[] = [];
    const openFn = mock(() => {
      const isDebater = callCount++ === 0;
      const scopeId = isDebater ? "debater-scope" : "resolver-scope";
      return {
        scopeId,
        snapshot: () => ({
          totalCostUsd: isDebater ? debaterCost : resolverCost,
          totalEstimatedCostUsd: 0,
          totalExactCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          callCount: 0,
          errorCount: 0,
        }),
        close: mock(() => {
          closed.push(scopeId);
        }),
      };
    });
    return { openScope: openFn, closed };
  }

  function makeCtxWithCostAgg(costAgg: ReturnType<typeof makeScopedCostAgg>): CallContext {
    const agentManager = makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: "ok",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      }),
    });
    const sm = makeSessionManager({
      openSession: mock(async (name: string) => ({ id: name, agentName: "claude" })),
      closeSession: mock(async () => {}),
    });
    return {
      runtime: {
        agentManager,
        sessionManager: sm,
        configLoader: { current: () => DEFAULT_CONFIG, select: (_: unknown) => DEFAULT_CONFIG } as any,
        packages: { resolve: () => ({ config: DEFAULT_CONFIG, select: (_: unknown) => DEFAULT_CONFIG }) } as any,
        signal: undefined,
        costAggregator: costAgg,
      } as any,
      packageView: { config: DEFAULT_CONFIG, select: (_: unknown) => DEFAULT_CONFIG } as any,
      packageDir: "/tmp/work",
      agentName: "claude",
      storyId: "US-cost",
      featureName: "feat-cost",
    };
  }

  function makeStatefulCostRunner(ctx: CallContext) {
    return new DebateRunner({
      ctx,
      stage: "review",
      stageConfig: makeStatefulStageConfig(),
      config: DEFAULT_CONFIG,
      workdir: "/tmp/work",
      sessionManager: (ctx.runtime as any).sessionManager,
    });
  }

  test("AC1: opens two scopes and closes both in finally", async () => {
    const costAgg = makeScopedCostAgg();
    const runner = makeStatefulCostRunner(makeCtxWithCostAgg(costAgg));
    await runner.run("prompt");
    expect(costAgg.openScope).toHaveBeenCalledTimes(2);
    expect(costAgg.closed).toContain("debater-scope");
    expect(costAgg.closed).toContain("resolver-scope");
  });

  test("AC2: debater callOp receives scopeId from debaterScope", async () => {
    const costAgg = makeScopedCostAgg();
    const ctx = makeCtxWithCostAgg(costAgg);
    const capturedIds: (string | undefined)[] = [];
    installCallOp(async (callCtx, op, input) => {
      if (op.name === "debate-stateful") capturedIds.push(callCtx.scopeId);
      input.proposalBarriers[0]?.resolve("ok");
      return { success: true, rebut: "ok" };
    });
    await makeStatefulCostRunner(ctx).run("prompt");
    expect(capturedIds.length).toBeGreaterThan(0);
    expect(capturedIds.every((id) => id === "debater-scope")).toBe(true);
  });

  test("AC6: totalCostUsd = debaterScope (0.10) + resolverScope (0.02) = 0.12", async () => {
    const costAgg = makeScopedCostAgg(0.1, 0.02);
    const ctx = makeCtxWithCostAgg(costAgg);
    installCallOp(async (_callCtx, _op, input) => {
      input.proposalBarriers[0]?.resolve("ok");
      return { success: true, rebut: "ok" };
    });
    const result = await makeStatefulCostRunner(ctx).run("prompt");
    expect(result.totalCostUsd).toBeCloseTo(0.12);
  });
});
