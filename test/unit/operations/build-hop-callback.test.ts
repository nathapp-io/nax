import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { buildHopCallback, _buildHopCallbackDeps } from "@/operations";
import type { BuildHopCallbackContext } from "@/operations";
import type { HopKind } from "@/agents";
import { makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";
import type { IAgentManager, RunAsSessionOpts } from "@/agents";
import { SessionFailureError } from "@/agents";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents";
import type { AdapterFailure, ContextBundle } from "@/context/engine";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WORKDIR = "/repo";
const SESSION_ID = "sess-abc123";

function makeBundle(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    pullTools: [],
    pushMarkdown: "## Context",
    manifest: {
      requestId: "req-1",
      agentId: "claude",
      createdAt: new Date(0).toISOString(),
      chunkIds: [],
      rebuildInfo: null,
    },
    ...overrides,
  } as unknown as ContextBundle;
}

function makeHandle(id = "nax-00000000"): SessionHandle {
  return { id, agentName: "claude" };
}

function makeStubTurnResult(output = "agent output"): TurnResult {
  return {
    output,
    tokenUsage: { inputTokens: 10, outputTokens: 20 },
    internalRoundTrips: 1,
    estimatedCostUsd: 0.001 ,
    exactCostUsd: 0.002,
    protocolIds: { recordId: "rec-turn", sessionId: "sess-turn" },
  };
}

function makeAgentManagerStub(runAsSessionFn?: () => Promise<TurnResult>): IAgentManager {
  return {
    runAsSession: mock(runAsSessionFn ?? (() => Promise.resolve(makeStubTurnResult()))),
  } as unknown as IAgentManager;
}

function makeBaseOptions(prompt = "do the work", config = makeNaxConfig()): AgentRunOptions {
  return {
    prompt,
    workdir: WORKDIR,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" } as AgentRunOptions["modelDef"],
    timeoutSeconds: 60,
    config,
  } as unknown as AgentRunOptions;
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
    _buildHopCallbackDeps.rebuildForAgent = mock(() => { throw new Error("should not rebuild on primary hop"); });

    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("do the work", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", makeBundle(), { kind: "primary" } satisfies HopKind, baseOptions);

    expect(_buildHopCallbackDeps.rebuildForAgent).not.toHaveBeenCalled();
    expect(sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
    expect(agentManager.runAsSession).toHaveBeenCalledTimes(1);

    const [agentArg, , promptArg] = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0] as [string, SessionHandle, string];
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

    const handoffMock = mock(() => ({} as never));
    const sessionManager = makeSessionManager({ handoff: handoffMock });
    const agentManager = makeAgentManagerStub();
    const ctx = makeCtx({ sessionManager, agentManager });
    const baseOptions = makeBaseOptions("original prompt", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("codex", makeBundle(), { kind: "swap", failure } satisfies HopKind, baseOptions);

    expect(_buildHopCallbackDeps.rebuildForAgent).toHaveBeenCalledWith(
      expect.anything(),
      "codex",
      failure,
      "US-001",
    );
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
});

describe("buildHopCallback — failure classification (Finding 3)", () => {
  test("preserves SessionFailureError adapterFailure with rate-limit outcome", async () => {
    const failure: AdapterFailure = {
      outcome: "fail-rate-limit",
      category: "availability",
      message: "rate limited by upstream",
      retriable: true,
    };
    const agentManager = makeAgentManagerStub(() =>
      Promise.reject(new SessionFailureError("rate limit", failure)),
    );
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
    const agentManager = makeAgentManagerStub(() =>
      Promise.reject(new SessionFailureError("auth fail", failure)),
    );
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
      openSession: mock(async () => { throw new Error("adapter unavailable"); }),
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
  let timeoutRetryMock: ReturnType<typeof mock>;

  beforeEach(() => {
    origTimeoutRetry = _buildHopCallbackDeps.timeoutRetry;
    timeoutRetryMock = mock(() => "RETRY-PROMPT-MOCK");
    _buildHopCallbackDeps.timeoutRetry = timeoutRetryMock as typeof _buildHopCallbackDeps.timeoutRetry;
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
    const callArgs = (timeoutRetryMock as ReturnType<typeof mock>).mock.calls[0] as unknown as [
      { prompt: string; changedFiles: string[]; elapsedMs: number },
    ];
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
    const captureWorkingTreeChangesMock = mock(async (_workdir: string, _ref: string) => [
      "src/foo.ts",
      "src/bar.ts",
    ]);
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
      const diffArgs = (captureWorkingTreeChangesMock as ReturnType<typeof mock>).mock.calls[0] as unknown as [
        string,
        string,
      ];
      expect(diffArgs[1]).toBe("deadbeef");

      const callArgs = (timeoutRetryMock as ReturnType<typeof mock>).mock.calls[0] as unknown as [
        { prompt: string; changedFiles: string[]; elapsedMs: number },
      ];
      expect(callArgs[0].changedFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
    } finally {
      _buildHopCallbackDeps.captureGitRef = origCaptureGitRef;
      _buildHopCallbackDeps.captureWorkingTreeChanges = origCaptureWorkingTreeChanges;
    }
  });
});
