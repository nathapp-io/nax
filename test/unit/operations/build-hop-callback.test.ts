import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeContextBundle,
  makeContextManifest,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeStory,
} from "@test/helpers";
import type { AgentRunOptions, HopKind, IAgentManager, RunAsSessionOpts, SessionHandle, TurnResult } from "@/agents";
import { SessionFailureError } from "@/agents";
import type { AdapterFailure, ContextBundle } from "@/context/engine";
import type { BuildHopCallbackContext } from "@/operations";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import type { TimeoutRetryInput } from "@/prompts";
import type { SessionDescriptor } from "@/session/types";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKDIR = "/repo";
const SESSION_ID = "sess-abc123";

function makeBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return makeContextBundle({
    pullTools: [],
    pushMarkdown: "## Context",
    manifest: makeContextManifest({ requestId: "req-1" }),
    ...overrides,
  });
}

function makeHandle(id = "nax-00000000"): SessionHandle {
  return { id, agentName: "claude" };
}

function makeStubTurnResult(output = "agent output"): TurnResult {
  return {
    output,
    tokenUsage: { inputTokens: 10, outputTokens: 20 },
    internalRoundTrips: 1,
    estimatedCostUsd: 0.001,
    exactCostUsd: 0.002,
    protocolIds: { recordId: "rec-turn", sessionId: "sess-turn" },
  };
}

function makeAgentManagerStub(runAsSessionFn?: () => Promise<TurnResult>): IAgentManager {
  return makeMockAgentManager({
    runAsSessionFn: runAsSessionFn ?? (() => Promise.resolve(makeStubTurnResult())),
  });
}

function makeBaseOptions(prompt = "do the work", config = makeNaxConfig()): AgentRunOptions {
  return {
    prompt,
    workdir: WORKDIR,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" } as AgentRunOptions["modelDef"],
    timeoutSeconds: 60,
    config,
  };
}

function makeCtx(overrides: Partial<BuildHopCallbackContext> = {}): BuildHopCallbackContext {
  return {
    sessionManager: makeSessionManager(),
    agentManager: makeAgentManagerStub(),
    story: makeStory({ id: "US-001" }),
    config: makeNaxConfig(),
    featureName: "test-feature",
    workdir: WORKDIR,
    effectiveTier: "balanced",
    defaultAgent: "claude",
    pipelineStage: "run",
    ...overrides,
  };
}

// ─── Dep mock save/restore ────────────────────────────────────────────────────

let origRebuild: typeof _buildHopCallbackDeps.rebuildForAgent;
let origWriteManifest: typeof _buildHopCallbackDeps.writeRebuildManifest;
let origCreateRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;

beforeEach(() => {
  origRebuild = _buildHopCallbackDeps.rebuildForAgent;
  origWriteManifest = _buildHopCallbackDeps.writeRebuildManifest;
  origCreateRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  // Default no-ops for all tests
  _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {});
  _buildHopCallbackDeps.createContextToolRuntime = mock(() => undefined);
});

afterEach(() => {
  _buildHopCallbackDeps.rebuildForAgent = origRebuild;
  _buildHopCallbackDeps.writeRebuildManifest = origWriteManifest;
  _buildHopCallbackDeps.createContextToolRuntime = origCreateRuntime;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("buildHopCallback — primary hop (no failure)", () => {
  test("uses resolvedRunOptions.modelDef on primary hop", async () => {
    const sessionManager = makeSessionManager({ openSession: mock(async () => makeHandle("nax-modeldef-handle")) });
    const agentManager = makeAgentManagerStub();
    const config = makeNaxConfig({
      models: {
        claude: {
          balanced: { provider: "anthropic", model: "claude-balanced-from-tier" },
        },
      },
    });
    const ctx = makeCtx({ sessionManager, agentManager, config });
    const baseOptions = makeBaseOptions("do the work", config);
    const pinnedModelDef = { provider: "unknown", model: "opencode-go/kimi-k2.6" };
    const optionsWithPinnedModel = { ...baseOptions, modelDef: pinnedModelDef } as AgentRunOptions;
    const cb = buildHopCallback(ctx, SESSION_ID, optionsWithPinnedModel);

    await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, optionsWithPinnedModel);

    const openOpts = (sessionManager.openSession as ReturnType<typeof mock>).mock.calls[0]?.[1] as {
      modelDef: { provider: string; model: string };
    };
    expect(openOpts.modelDef).toEqual(pinnedModelDef);
  });

  test("opens and closes session; calls runAsSession with initial prompt; wraps TurnResult", async () => {
    const turnResult = makeStubTurnResult("hello from agent");
    const agentManager = makeAgentManagerStub(() => Promise.resolve(turnResult));
    const sessionManager = makeSessionManager({ openSession: mock(async () => makeHandle("nax-test-handle")) });
    _buildHopCallbackDeps.rebuildForAgent = mock(() => {
      throw new Error("should not rebuild on primary hop");
    });

    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("do the work", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);

    expect(_buildHopCallbackDeps.rebuildForAgent).not.toHaveBeenCalled();
    expect(sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
    expect(agentManager.runAsSession).toHaveBeenCalledTimes(1);

    const [agentArg, , promptArg] = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0] as [
      string,
      SessionHandle,
      string,
    ];
    expect(agentArg).toBe("claude");
    expect(promptArg).toBe("do the work");

    expect(hop.result.success).toBe(true);
    expect(hop.result.output).toBe("hello from agent");
    expect(hop.result.estimatedCostUsd).toBe(0.001);
    expect(hop.result.exactCostUsd).toBe(0.002);
    expect(hop.result.tokenUsage).toEqual(turnResult.tokenUsage);
    expect(hop.result.protocolIds).toEqual({ recordId: "rec-turn", sessionId: "sess-turn" });
    expect(hop.result.internalRoundTrips).toBe(1);
  });

  // SEC-3 follow-up (Round 2 review): buildHopCallback already had the
  // per-package `config` in scope (used for config.models / sessionTimeoutSeconds)
  // but never threaded it into openSession/runAsSession, so a per-package
  // execution.permissionProfile override was silently ignored on the primary
  // callOp hop path — the majority of agent dispatch. Pins that both openSession
  // calls and the runAsSession call receive the per-package config.
  test("threads per-package config into openSession and runAsSession (SEC-3)", async () => {
    const sessionManager = makeSessionManager({ openSession: mock(async () => makeHandle("nax-sec3-handle")) });
    const agentManager = makeAgentManagerStub();
    const packageConfig = makeNaxConfig({ execution: { permissionProfile: "safe" } });
    const ctx = makeCtx({ sessionManager, agentManager, config: packageConfig });
    const baseOptions = makeBaseOptions("do the work", packageConfig);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);

    const openOpts = (sessionManager.openSession as ReturnType<typeof mock>).mock.calls[0]?.[1] as {
      config?: unknown;
    };
    expect(openOpts.config).toBe(packageConfig);

    const sessionOpts = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0]?.[3] as RunAsSessionOpts;
    expect(sessionOpts.config).toBe(packageConfig);
  });

  test("keepOpen:true — closeSession is NOT called after the turn", async () => {
    const sessionManager = makeSessionManager({
      openSession: mock(async () => makeHandle("nax-warm-handle")),
      closeSession: mock(async () => {}),
    });
    const agentManager = makeAgentManagerStub();
    const ctx = makeCtx({ sessionManager, agentManager });
    const warmOptions = { ...makeBaseOptions(), keepOpen: true } as AgentRunOptions;

    const cb = buildHopCallback(ctx, SESSION_ID, warmOptions);
    const hop = await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, warmOptions);

    expect(hop.result.success).toBe(true);
    expect(sessionManager.closeSession).not.toHaveBeenCalled();
  });
});

describe("buildHopCallback — failure hop (fallback)", () => {
  test("uses tier-derived modelDef on failure hop", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-rate-limit",
      category: "availability",
      message: "rate limit hit",
      retriable: true,
    };
    _buildHopCallbackDeps.rebuildForAgent = mock(() => makeBundle({ pushMarkdown: "## Rebuilt context" }));

    const config = makeNaxConfig({
      models: {
        codex: {
          balanced: { provider: "openai", model: "gpt-5" },
        },
      },
    });
    const sessionManager = makeSessionManager();
    const agentManager = makeAgentManagerStub();
    const ctx = makeCtx({ sessionManager, agentManager, config });
    const baseOptions = makeBaseOptions("original prompt", config);
    const optionsWithPinnedModel = {
      ...baseOptions,
      modelDef: { provider: "unknown", model: "opencode-go/kimi-k2.6" },
    } as AgentRunOptions;
    const cb = buildHopCallback(ctx, SESSION_ID, optionsWithPinnedModel);

    await cb("codex", makeBundle(), { kind: "swap", failure } satisfies HopKind, optionsWithPinnedModel);

    const openOpts = (sessionManager.openSession as ReturnType<typeof mock>).mock.calls[0]?.[1] as {
      modelDef: { provider: string; model: string };
    };
    expect(openOpts.modelDef).toEqual({ provider: "openai", model: "gpt-5" });
  });

  test("rebuilds bundle; calls handoff; rewrites prompt via swapHandoff; closes session", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-rate-limit",
      category: "availability",
      message: "rate limit hit",
      retriable: true,
    };

    const rebuiltBundle = makeBundle({ pushMarkdown: "## Rebuilt context" });
    _buildHopCallbackDeps.rebuildForAgent = mock(() => rebuiltBundle);

    const handoffDescriptor: SessionDescriptor = {
      id: SESSION_ID,
      role: "main",
      state: "RUNNING",
      agent: "codex",
      workdir: "/tmp",
      protocolIds: { recordId: null, sessionId: null },
      completedStages: [],
      createdAt: new Date(0).toISOString(),
      lastActivityAt: new Date(0).toISOString(),
    };
    const handoffMock = mock(() => handoffDescriptor);
    const sessionManager = makeSessionManager({ handoff: handoffMock });
    const agentManager = makeAgentManagerStub();
    const ctx = makeCtx({ sessionManager, agentManager });
    const baseOptions = makeBaseOptions("original prompt", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("codex", makeBundle(), { kind: "swap", failure } satisfies HopKind, baseOptions);

    expect(_buildHopCallbackDeps.rebuildForAgent).toHaveBeenCalledWith(expect.anything(), "codex", failure, "US-001");
    expect(handoffMock).toHaveBeenCalledWith(SESSION_ID, "codex", failure.outcome);
    expect(sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);

    // Prompt should be rewritten for swap handoff
    const promptArg = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0]?.[2] as string;
    expect(typeof promptArg).toBe("string");
    expect(promptArg).not.toBe("original prompt");

    expect(hop.result.success).toBe(true);
    expect(hop.bundle).toBe(rebuiltBundle);
  });
});

describe("buildHopCallback — runAsSession throws", () => {
  test("closeSession still called in finally; error returned as failure AgentResult", async () => {
    const agentManager = makeAgentManagerStub(() => Promise.reject(new Error("session error")));
    const sessionManager = makeSessionManager();
    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);

    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
    expect(hop.result.success).toBe(false);
    expect(hop.result.exitCode).toBe(1);
    expect(hop.result.output).toContain("session error");
  });

  // BUG-57: a SessionTurnError (e.g. a mid-flight cancel) carries whatever
  // tokenUsage/cost the adapter already accumulated before failing — the
  // failure AgentResult must surface it instead of hardcoding
  // estimatedCostUsd: 0, or real spend silently disappears from cost accounting.
  test("SessionTurnError's carried tokenUsage/cost flow through to the failure AgentResult", async () => {
    const { SessionTurnError } = await import("@/agents");
    const turnError = new SessionTurnError(
      "Agent session ended with stop reason: error (externally cancelled)",
      true,
      false,
      { inputTokens: 400, outputTokens: 175 },
      0.0123,
      0.0111,
    );
    const agentManager = makeAgentManagerStub(() => Promise.reject(turnError));
    const sessionManager = makeSessionManager();
    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);

    expect(hop.result.success).toBe(false);
    expect(hop.result.estimatedCostUsd).toBe(0.0123);
    expect(hop.result.exactCostUsd).toBe(0.0111);
    expect(hop.result.tokenUsage?.inputTokens).toBe(400);
    expect(hop.result.tokenUsage?.outputTokens).toBe(175);
  });
});

describe("buildHopCallback — failure classification (Finding 3)", () => {
  test("preserves SessionFailureError adapterFailure with rate-limit outcome", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-rate-limit",
      category: "availability",
      message: "rate limited by upstream",
      retriable: true,
    };
    const agentManager = makeAgentManagerStub(() => Promise.reject(new SessionFailureError("rate limit", failure)));
    const sessionManager = makeSessionManager();
    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", undefined, { kind: "primary" } satisfies HopKind, baseOptions);

    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
    expect(hop.result.success).toBe(false);
    expect(hop.result.rateLimited).toBe(true);
    expect(hop.result.adapterFailure?.outcome).toBe("fail-rate-limit");
    expect(hop.result.adapterFailure?.category).toBe("availability");
  });

  test("preserves SessionFailureError adapterFailure with auth-error outcome", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-auth",
      category: "availability",
      message: "missing credentials",
      retriable: false,
    };
    const agentManager = makeAgentManagerStub(() => Promise.reject(new SessionFailureError("auth fail", failure)));
    const ctx = makeCtx({ agentManager });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", undefined, { kind: "primary" } satisfies HopKind, baseOptions);

    expect(hop.result.success).toBe(false);
    expect(hop.result.rateLimited).toBe(false);
    expect(hop.result.adapterFailure?.outcome).toBe("fail-auth");
    expect(hop.result.adapterFailure?.message).toBe("missing credentials");
  });

  test("falls back to generic availability/fail-adapter-error for non-typed errors", async () => {
    const agentManager = makeAgentManagerStub(() => Promise.reject(new Error("plain network error")));
    const ctx = makeCtx({ agentManager });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", undefined, { kind: "primary" } satisfies HopKind, baseOptions);

    expect(hop.result.success).toBe(false);
    expect(hop.result.rateLimited).toBe(false);
    expect(hop.result.adapterFailure?.outcome).toBe("fail-adapter-error");
    expect(hop.result.adapterFailure?.category).toBe("availability");
    expect(hop.result.output).toContain("plain network error");
  });
});

describe("buildHopCallback — hopBody (multi-prompt within one hop)", () => {
  test("invokes hopBody with bound send closure; runs initial prompt followed by retry", async () => {
    const turn1 = makeStubTurnResult("first-output");
    const turn2 = makeStubTurnResult("second-output");
    let runAsCount = 0;
    const agentManager = makeAgentManagerStub(() => {
      runAsCount++;
      return Promise.resolve(runAsCount === 1 ? turn1 : turn2);
    });
    const sessionManager = makeSessionManager();
    const observed: string[] = [];

    const ctx = makeCtx({
      agentManager,
      sessionManager,
      hopBody: async (initial, body) => {
        observed.push(initial);
        const a = await body.send(initial);
        observed.push(`after-first:${a.output}`);
        return body.send("retry-prompt");
      },
      hopBodyInput: { foo: "bar" },
    });
    const baseOptions = makeBaseOptions("initial-prompt", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", undefined, { kind: "primary" } satisfies HopKind, baseOptions);

    expect(observed).toEqual(["initial-prompt", "after-first:first-output"]);
    expect(runAsCount).toBe(2);
    expect(hop.result.success).toBe(true);
    expect(hop.result.output).toBe("second-output");
    // openSession + closeSession still called exactly once across both prompts
    expect(sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
  });

  test("default body (no hopBody) sends initial prompt once", async () => {
    const agentManager = makeAgentManagerStub();
    const ctx = makeCtx({ agentManager });
    const baseOptions = makeBaseOptions("only-prompt", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", undefined, { kind: "primary" } satisfies HopKind, baseOptions);

    expect(agentManager.runAsSession).toHaveBeenCalledTimes(1);
    const promptArg = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0]?.[2] as string;
    expect(promptArg).toBe("only-prompt");
  });
});

describe("buildHopCallback — openSession throws", () => {
  test("no runAsSession call; no closeSession call; error propagates", async () => {
    const sessionManager = makeSessionManager({
      openSession: mock(async () => {
        throw new Error("adapter unavailable");
      }),
    });
    const agentManager = makeAgentManagerStub();
    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    let thrown: Error | null = null;
    try {
      await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toContain("adapter unavailable");

    expect(agentManager.runAsSession).not.toHaveBeenCalled();
    expect(sessionManager.closeSession).not.toHaveBeenCalled();
  });
});

describe("buildHopCallback — interactionBridge threading (AC6/AC7)", () => {
  test("passes non-null interactionHandler to runAsSession when ctx.interactionBridge is set", async () => {
    const agentManager = makeAgentManagerStub();
    const ctx = makeCtx({
      agentManager,
      interactionBridge: {
        detectQuestion: async (_: string) => false,
        onQuestionDetected: async (_: string) => "answer",
      },
    });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", undefined, { kind: "primary" } satisfies HopKind, baseOptions);

    const opts = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0]?.[3] as RunAsSessionOpts;
    expect(opts.interactionHandler).not.toBeUndefined();
    expect(opts.interactionHandler).not.toBeNull();
  });

  test("passes maxTurns to runAsSession when ctx.maxInteractionTurns is set", async () => {
    const agentManager = makeAgentManagerStub();
    const ctx = makeCtx({
      agentManager,
      maxInteractionTurns: 5,
    });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", undefined, { kind: "primary" } satisfies HopKind, baseOptions);

    const opts = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0]?.[3] as RunAsSessionOpts;
    expect(opts.maxTurns).toBe(5);
  });
});

// ─── timeoutRetry prompt wiring (AC6/AC7) ────────────────────────────────────
//
// The retry prompt must be composed ONLY for timeout-retry hops, with the
// original prompt + the list of changed files captured against the pre-attempt
// git ref. Primary and stale-retry hops must NOT touch the injected helper.

describe("buildHopCallback — timeoutRetry wiring (AC6/AC7)", () => {
  let origTimeoutRetry: typeof _buildHopCallbackDeps.timeoutRetry;
  let timeoutRetryMock: ReturnType<typeof mock<(input: TimeoutRetryInput) => string>>;

  beforeEach(() => {
    origTimeoutRetry = _buildHopCallbackDeps.timeoutRetry;
    timeoutRetryMock = mock((_input: TimeoutRetryInput) => "RETRY-PROMPT-MOCK");
    _buildHopCallbackDeps.timeoutRetry = timeoutRetryMock;
  });

  afterEach(() => {
    _buildHopCallbackDeps.timeoutRetry = origTimeoutRetry;
  });

  test("AC6: timeout-retry hop calls the injected timeoutRetry exactly once with the original prompt + changed files", async () => {
    const agentManager = makeAgentManagerStub();
    const sessionManager = makeSessionManager();
    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("original prompt", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", makeBundle(), { kind: "timeout-retry", attempt: 1 } satisfies HopKind, baseOptions);

    expect(timeoutRetryMock).toHaveBeenCalledTimes(1);
    const callArgs = timeoutRetryMock.mock.calls[0];
    expect(callArgs[0].prompt).toBe("original prompt");
    expect(Array.isArray(callArgs[0].changedFiles)).toBe(true);
    expect(typeof callArgs[0].elapsedMs).toBe("number");

    // The composed prompt is forwarded to the agent via runAsSession.
    const promptArg = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0]?.[2] as string;
    expect(promptArg).toBe("RETRY-PROMPT-MOCK");
  });

  test("AC7: primary hop does NOT call the injected timeoutRetry", async () => {
    const agentManager = makeAgentManagerStub();
    const sessionManager = makeSessionManager();
    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("original prompt", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);

    expect(timeoutRetryMock).not.toHaveBeenCalled();
  });

  test("AC7: stale-retry hop does NOT call the injected timeoutRetry", async () => {
    const agentManager = makeAgentManagerStub();
    const sessionManager = makeSessionManager({ getLiveHandle: mock(() => makeHandle()) });
    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("original prompt", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", makeBundle(), { kind: "stale-retry", attempt: 1 } satisfies HopKind, baseOptions);

    expect(timeoutRetryMock).not.toHaveBeenCalled();
  });

  test("timeout-retry hop forwards the working-tree diff captured against the pre-attempt ref", async () => {
    // Exercises the git-ref capture path: stub _buildHopCallbackDeps.captureGitRef
    // to return a fake ref, and stub captureWorkingTreeChanges to return the diff.
    // The timeout-retry hop must call captureWorkingTreeChanges with that ref and
    // forward the result to timeoutRetry.
    const origCaptureGitRef = _buildHopCallbackDeps.captureGitRef;
    const origCaptureWorkingTreeChanges = _buildHopCallbackDeps.captureWorkingTreeChanges;
    const captureGitRefMock = mock(async (_workdir: string) => "deadbeef");
    const captureWorkingTreeChangesMock: ReturnType<typeof mock<(workdir: string, ref: string) => Promise<string[]>>> =
      mock(async (_workdir: string, _ref: string) => ["src/foo.ts", "src/bar.ts"]);
    _buildHopCallbackDeps.captureGitRef = captureGitRefMock as typeof _buildHopCallbackDeps.captureGitRef;
    _buildHopCallbackDeps.captureWorkingTreeChanges =
      captureWorkingTreeChangesMock as typeof _buildHopCallbackDeps.captureWorkingTreeChanges;

    try {
      const agentManager = makeAgentManagerStub();
      const sessionManager = makeSessionManager();
      const ctx = makeCtx({ agentManager, sessionManager });
      const baseOptions = makeBaseOptions("original prompt", ctx.config);
      const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

      // Pre-attempt ref captured on primary hop.
      await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);
      expect(captureGitRefMock).toHaveBeenCalledTimes(1);

      // Timeout-retry hop diffs the working tree against the captured ref.
      await cb("claude", makeBundle(), { kind: "timeout-retry", attempt: 1 } satisfies HopKind, baseOptions);
      expect(captureWorkingTreeChangesMock).toHaveBeenCalledTimes(1);
      const diffArgs = captureWorkingTreeChangesMock.mock.calls[0];
      expect(diffArgs[1]).toBe("deadbeef");

      const callArgs = timeoutRetryMock.mock.calls[0];
      expect(callArgs[0].changedFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
    } finally {
      _buildHopCallbackDeps.captureGitRef = origCaptureGitRef;
      _buildHopCallbackDeps.captureWorkingTreeChanges = origCaptureWorkingTreeChanges;
    }
  });

  test("AC8 wiring: timeout-retry hop resolves to generic preamble when pre-attempt git ref is unavailable", async () => {
    // Adversarial review (US-003): the pure prompt builder's degraded form is
    // already covered in timeout-retry-builder.test.ts. This test closes the
    // wiring-layer gap — when captureGitRef returns undefined (ref unavailable),
    // executeHop MUST:
    //   (a) NOT call captureWorkingTreeChanges (no diff against an absent ref)
    //   (b) call timeoutRetry exactly once with changedFiles: []
    //   (c) forward the composed prompt to runAsSession without throwing
    const origCaptureGitRef = _buildHopCallbackDeps.captureGitRef;
    const origCaptureWorkingTreeChanges = _buildHopCallbackDeps.captureWorkingTreeChanges;
    const captureGitRefMock = mock(async (_workdir: string) => undefined as string | undefined);
    const captureWorkingTreeChangesMock = mock(async (_workdir: string, _ref: string) => ["should-not-appear.ts"]);
    _buildHopCallbackDeps.captureGitRef = captureGitRefMock as typeof _buildHopCallbackDeps.captureGitRef;
    _buildHopCallbackDeps.captureWorkingTreeChanges =
      captureWorkingTreeChangesMock as typeof _buildHopCallbackDeps.captureWorkingTreeChanges;

    try {
      const agentManager = makeAgentManagerStub();
      const sessionManager = makeSessionManager();
      const ctx = makeCtx({ agentManager, sessionManager });
      const baseOptions = makeBaseOptions("original prompt", ctx.config);
      const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

      // Primary hop: captureGitRef returns undefined (ref unavailable).
      await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);
      expect(captureGitRefMock).toHaveBeenCalledTimes(1);

      // Timeout-retry hop: must NOT call captureWorkingTreeChanges because
      // the pre-attempt ref is unavailable.
      await cb("claude", makeBundle(), { kind: "timeout-retry", attempt: 1 } satisfies HopKind, baseOptions);
      expect(captureWorkingTreeChangesMock).not.toHaveBeenCalled();

      // timeoutRetry must still be called exactly once with changedFiles: [].
      expect(timeoutRetryMock).toHaveBeenCalledTimes(1);
      const callArgs = timeoutRetryMock.mock.calls[0];
      expect(callArgs[0].prompt).toBe("original prompt");
      expect(callArgs[0].changedFiles).toEqual([]);

      // The composed prompt is forwarded to the agent without throwing.
      // runAsSession was called for BOTH the primary AND the timeout-retry
      // hops (the primary openSession'd then closed; the timeout-retry did too).
      // We need to inspect the timeout-retry hop's prompt, which is the LAST call.
      const runAsSessionCalls = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls;
      const lastRunCall = runAsSessionCalls[runAsSessionCalls.length - 1];
      const promptArg = lastRunCall?.[2] as string;
      expect(promptArg).toBe("RETRY-PROMPT-MOCK");
    } finally {
      _buildHopCallbackDeps.captureGitRef = origCaptureGitRef;
      _buildHopCallbackDeps.captureWorkingTreeChanges = origCaptureWorkingTreeChanges;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-005: story scratch directory handoff to the pull-tool runtime. The runtime
// must receive the same storyScratchDirs the stage-assembly path resolved, so
// the query_scratch handler reads the same session data as push providers.
// ─────────────────────────────────────────────────────────────────────────────

describe("buildHopCallback — storyScratchDirs handoff to runtime (US-005)", () => {
  test("passes ctx.storyScratchDirs through to createContextToolRuntime unchanged", async () => {
    const SCRATCH_DIRS = ["/tmp/nax-scratch-sess-001", "/tmp/nax-scratch-sess-002"];
    let capturedOptions: Parameters<typeof _buildHopCallbackDeps.createContextToolRuntime>[0] | undefined;
    const createRuntimeMock = mock((opts: Parameters<typeof _buildHopCallbackDeps.createContextToolRuntime>[0]) => {
      capturedOptions = opts;
      return undefined;
    });
    _buildHopCallbackDeps.createContextToolRuntime =
      createRuntimeMock as typeof _buildHopCallbackDeps.createContextToolRuntime;

    const agentManager = makeAgentManagerStub();
    const sessionManager = makeSessionManager();
    const ctx = makeCtx({
      agentManager,
      sessionManager,
    }) as BuildHopCallbackContext & { storyScratchDirs?: string[] };
    ctx.storyScratchDirs = SCRATCH_DIRS;

    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.storyScratchDirs).toEqual(SCRATCH_DIRS);
    // The requesting (hop) agent must be threaded so query_scratch neutralizes
    // tool references for the actual reader (AC10), not the story.id default.
    expect(capturedOptions?.agentId).toBe("claude");
  });

  test("omits storyScratchDirs when ctx.storyScratchDirs is absent", async () => {
    let capturedOptions: Parameters<typeof _buildHopCallbackDeps.createContextToolRuntime>[0] | undefined;
    const createRuntimeMock = mock((opts: Parameters<typeof _buildHopCallbackDeps.createContextToolRuntime>[0]) => {
      capturedOptions = opts;
      return undefined;
    });
    _buildHopCallbackDeps.createContextToolRuntime =
      createRuntimeMock as typeof _buildHopCallbackDeps.createContextToolRuntime;

    const agentManager = makeAgentManagerStub();
    const sessionManager = makeSessionManager();
    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("p", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);

    expect(capturedOptions).toBeDefined();
    // No storyScratchDirs — either undefined or empty array
    expect(capturedOptions?.storyScratchDirs ?? []).toEqual([]);
  });
});
