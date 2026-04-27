import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { buildHopCallback, _buildHopCallbackDeps } from "../../../src/operations/build-hop-callback";
import type { BuildHopCallbackContext } from "../../../src/operations/build-hop-callback";
import { makeNaxConfig, makeSessionManager, makeStory } from "../../helpers";
import type { IAgentManager } from "../../../src/agents/manager-types";
import { SessionFailureError } from "../../../src/agents/types";
import type { AgentRunOptions, SessionHandle, TurnResult } from "../../../src/agents/types";
import type { AdapterFailure, ContextBundle } from "../../../src/context/engine";

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
    cost: { total: 0.001 },
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
  test("opens and closes session; calls runAsSession with initial prompt; wraps TurnResult", async () => {
    const turnResult = makeStubTurnResult("hello from agent");
    const agentManager = makeAgentManagerStub(() => Promise.resolve(turnResult));
    const sessionManager = makeSessionManager({ openSession: mock(async () => makeHandle("nax-test-handle")) });
    _buildHopCallbackDeps.rebuildForAgent = mock(() => { throw new Error("should not rebuild on primary hop"); });

    const ctx = makeCtx({ agentManager, sessionManager });
    const baseOptions = makeBaseOptions("do the work", ctx.config);
    const cb = buildHopCallback(ctx, SESSION_ID, baseOptions);

    const hop = await cb("claude", makeBundle(), undefined, baseOptions);

    expect(_buildHopCallbackDeps.rebuildForAgent).not.toHaveBeenCalled();
    expect(sessionManager.openSession).toHaveBeenCalledTimes(1);
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
    expect(agentManager.runAsSession).toHaveBeenCalledTimes(1);

    const [agentArg, , promptArg] = (agentManager.runAsSession as ReturnType<typeof mock>).mock.calls[0] as [string, SessionHandle, string];
    expect(agentArg).toBe("claude");
    expect(promptArg).toBe("do the work");

    expect(hop.result.success).toBe(true);
    expect(hop.result.output).toBe("hello from agent");
    expect(hop.result.estimatedCost).toBe(0.001);
    expect(hop.result.tokenUsage).toEqual(turnResult.tokenUsage);
  });
});

describe("buildHopCallback — failure hop (fallback)", () => {
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

    const hop = await cb("codex", makeBundle(), failure, baseOptions);

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

    const hop = await cb("claude", makeBundle(), undefined, baseOptions);

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

    const hop = await cb("claude", undefined, undefined, baseOptions);

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

    const hop = await cb("claude", undefined, undefined, baseOptions);

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

    const hop = await cb("claude", undefined, undefined, baseOptions);

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

    const hop = await cb("claude", undefined, undefined, baseOptions);

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

    await cb("claude", undefined, undefined, baseOptions);

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
      await cb("claude", makeBundle(), undefined, baseOptions);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown?.message).toContain("adapter unavailable");

    expect(agentManager.runAsSession).not.toHaveBeenCalled();
    expect(sessionManager.closeSession).not.toHaveBeenCalled();
  });
});
