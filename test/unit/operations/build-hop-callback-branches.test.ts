/**
 * Characterisation tests for buildHopCallback branches nothing else pins.
 *
 * Written before the A5 cognitive-complexity drain (docs/plans/STATUS-complexity-drain.md)
 * so the refactor moves behaviour that is already pinned: the coding-tool-root failure
 * conversion (#1794), the rebuild-manifest write (both arms), the timedOut-overrides-
 * keepOpen close, and the `endpoint`/`dispatched` fields the fallback loop reads
 * (nax#1965 / US-001). All green against the unrefactored closure.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  makeContextBundle,
  makeContextManifest,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeStory,
} from "@test/helpers";
import type { HopKind } from "@/agents";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents/types";
import type { AdapterFailure } from "@/context/engine";
import type { BuildHopCallbackContext } from "@/operations";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";

const WORKDIR = "/repo";
const SESSION_ID = "sess-branches";

const SWAP_FAILURE: AdapterFailure = {
  outcome: "fail-rate-limit",
  category: "availability",
  message: "rate limit hit",
  retriable: true,
};

function makeHandle(id = "nax-branch-handle"): SessionHandle {
  return { id, agentName: "claude" };
}

function makeStubTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    output: "agent output",
    tokenUsage: { inputTokens: 10, outputTokens: 20 },
    internalRoundTrips: 1,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

function makeBaseOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "do the work",
    workdir: WORKDIR,
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: makeNaxConfig(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<BuildHopCallbackContext> = {}): BuildHopCallbackContext {
  return {
    sessionManager: makeSessionManager({ openSession: mock(async () => makeHandle()) }),
    agentManager: makeMockAgentManager({ runAsSessionFn: mock(async () => makeStubTurnResult()) }),
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

let origWriteManifest: typeof _buildHopCallbackDeps.writeRebuildManifest;
let origRebuildForAgent: typeof _buildHopCallbackDeps.rebuildForAgent;

beforeEach(() => {
  origWriteManifest = _buildHopCallbackDeps.writeRebuildManifest;
  origRebuildForAgent = _buildHopCallbackDeps.rebuildForAgent;
  _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {});
});

afterEach(() => {
  _buildHopCallbackDeps.writeRebuildManifest = origWriteManifest;
  _buildHopCallbackDeps.rebuildForAgent = origRebuildForAgent;
});

describe("buildHopCallback — endpoint + dispatched on the hop result (nax#1965 / US-001)", () => {
  test("a primary hop reports the endpoint it dispatched and dispatched: true", async () => {
    const pinnedModelDef = { provider: "unknown", model: "opencode-go/kimi-k2.6" };
    const options = makeBaseOptions({ modelDef: pinnedModelDef });
    const cb = buildHopCallback(makeCtx(), SESSION_ID, options);

    const hop = await cb("claude", makeContextBundle(), { kind: "primary" } satisfies HopKind, options);

    // A pin wins on primary and reports no modelTier (#1433).
    expect(hop.endpoint).toEqual({ modelDef: pinnedModelDef });
    expect(hop.dispatched).toBe(true);
  });

  test("a stale-retry warm-handle reuse reports no endpoint (openFresh never ran)", async () => {
    const sessionManager = makeSessionManager({ getLiveHandle: mock(() => makeHandle("nax-warm")) });
    const cb = buildHopCallback(makeCtx({ sessionManager }), SESSION_ID, makeBaseOptions());

    const hop = await cb("claude", undefined, { kind: "stale-retry", attempt: 2 } satisfies HopKind, makeBaseOptions());

    expect(hop.result.success).toBe(true);
    expect(hop.endpoint).toBeUndefined();
    expect(hop.dispatched).toBe(true);
  });

  test("a stale-retry that reopened fresh DOES report the endpoint it opened", async () => {
    const pinnedModelDef = { provider: "unknown", model: "opencode-go/kimi-k2.6" };
    const options = makeBaseOptions({ modelDef: pinnedModelDef });
    const sessionManager = makeSessionManager({
      getLiveHandle: mock(() => makeHandle("nax-cancelled")),
      isCancelled: mock(() => true),
      openSession: mock(async () => makeHandle("nax-fresh")),
      closeSession: mock(async () => {}),
    });
    const cb = buildHopCallback(makeCtx({ sessionManager }), SESSION_ID, options);

    const hop = await cb("claude", undefined, { kind: "stale-retry", attempt: 2 } satisfies HopKind, options);

    expect(hop.endpoint).toEqual({ modelDef: pinnedModelDef });
  });

  test("the catch path reports dispatched: false and no endpoint — no model was reached", async () => {
    const agentManager = makeMockAgentManager({
      runAsSessionFn: mock(async () => {
        throw new Error("session error");
      }),
    });
    const options = makeBaseOptions();
    const cb = buildHopCallback(makeCtx({ agentManager }), SESSION_ID, options);

    const hop = await cb("claude", makeContextBundle(), { kind: "primary" } satisfies HopKind, options);

    expect(hop.result.success).toBe(false);
    expect(hop.endpoint).toBeUndefined();
    expect(hop.dispatched).toBe(false);
  });
});

describe("buildHopCallback — coding-tool resolution throws (#1794 conversion)", () => {
  test("a thrown CODING_TOOL_ROOT_MISSING becomes a failed AgentResult, not a propagated throw", async () => {
    // Declared tools + safe-profile grants exist, but codingToolRoot is absent —
    // resolveCodingToolSupport refuses (the #1794 defect shape). The hop MUST
    // convert the throw into a failed AgentResult so runWithFallback's swap
    // policy can classify it; a propagated throw would also skip the finally's
    // closeSession.
    const sessionManager = makeSessionManager();
    const agentManager = makeMockAgentManager({ runAsSessionFn: mock(async () => makeStubTurnResult()) });
    const config = makeNaxConfig({ execution: { permissionProfile: "safe" } });
    const options = makeBaseOptions({ declaredTools: ["Read"], config });
    const bundle = makeContextBundle();
    const cb = buildHopCallback(makeCtx({ sessionManager, agentManager, config }), SESSION_ID, options);

    let thrown: unknown;
    let hop: Awaited<ReturnType<typeof cb>> | undefined;
    try {
      hop = await cb("claude", bundle, { kind: "primary" } satisfies HopKind, options);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(hop).toBeDefined();
    expect(hop?.result.success).toBe(false);
    expect(hop?.result.exitCode).toBe(1);
    expect(hop?.result.output).toContain('Agent "claude" failed:');
    expect(hop?.bundle).toBe(bundle);
    expect(hop?.dispatched).toBe(false);
    // Failed before any session work: nothing opened, nothing dispatched, nothing to close.
    expect(sessionManager.openSession).not.toHaveBeenCalled();
    expect(agentManager.runAsSession).not.toHaveBeenCalled();
    expect(sessionManager.closeSession).not.toHaveBeenCalled();
  });
});

describe("buildHopCallback — rebuild manifest write on swap", () => {
  const REBUILD_INFO = {
    priorAgentId: "claude",
    newAgentId: "codex",
    failureCategory: "availability" as const,
    failureOutcome: "fail-rate-limit" as const,
    priorChunkIds: ["c1", "c2"],
    newChunkIds: ["r1", "r2"],
    chunkIdMap: [{ priorChunkId: "c1", newChunkId: "r1" }],
  };

  function makeRebuiltBundle() {
    return makeContextBundle({
      pushMarkdown: "## Rebuilt context",
      manifest: makeContextManifest({ requestId: "req-rebuilt", rebuildInfo: REBUILD_INFO }),
    });
  }

  test("a swap with projectDir + rebuildInfo writes the manifest with the rebuilt fields", async () => {
    const rebuilt = makeRebuiltBundle();
    _buildHopCallbackDeps.rebuildForAgent = mock(() => rebuilt);
    const manifestCalls: unknown[] = [];
    _buildHopCallbackDeps.writeRebuildManifest = mock(async (...args: unknown[]) => {
      manifestCalls.push(args);
    });
    const options = makeBaseOptions();
    const cb = buildHopCallback(makeCtx({ projectDir: "/proj" }), SESSION_ID, options);

    const hop = await cb(
      "codex",
      makeContextBundle(),
      { kind: "swap", failure: SWAP_FAILURE } satisfies HopKind,
      options,
    );

    expect(manifestCalls).toHaveLength(1);
    const [projectDir, featureName, storyId, payload] = manifestCalls[0] as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(projectDir).toBe("/proj");
    expect(featureName).toBe("test-feature");
    expect(storyId).toBe("US-001");
    expect(payload.requestId).toBe("req-rebuilt");
    expect(payload.stage).toBe("execution");
    expect(payload.priorAgentId).toBe("claude");
    expect(payload.newAgentId).toBe("codex");
    expect(payload.failureCategory).toBe("availability");
    expect(payload.failureOutcome).toBe("fail-rate-limit");
    expect(payload.priorChunkIds).toEqual(["c1", "c2"]);
    expect(payload.newChunkIds).toEqual(["r1", "r2"]);
    expect(payload.chunkIdMap).toEqual([{ priorChunkId: "c1", newChunkId: "r1" }]);
    expect(typeof payload.createdAt).toBe("string");
    // The hop itself still succeeds on the rebuilt bundle.
    expect(hop.result.success).toBe(true);
    expect(hop.bundle).toBe(rebuilt);
  });

  test("a swap without rebuildInfo does not write the manifest", async () => {
    _buildHopCallbackDeps.rebuildForAgent = mock((prior) => prior);
    const manifestCalls: unknown[] = [];
    _buildHopCallbackDeps.writeRebuildManifest = mock(async (...args: unknown[]) => {
      manifestCalls.push(args);
    });
    const cb = buildHopCallback(makeCtx({ projectDir: "/proj" }), SESSION_ID, makeBaseOptions());

    await cb(
      "codex",
      makeContextBundle(),
      { kind: "swap", failure: SWAP_FAILURE } satisfies HopKind,
      makeBaseOptions(),
    );

    expect(manifestCalls).toHaveLength(0);
  });

  test("a manifest write failure is swallowed — the hop proceeds with the rewritten prompt", async () => {
    _buildHopCallbackDeps.rebuildForAgent = mock(() => makeRebuiltBundle());
    _buildHopCallbackDeps.writeRebuildManifest = mock(async () => {
      throw new Error("disk full");
    });
    const options = makeBaseOptions({ prompt: "original prompt" });
    const cb = buildHopCallback(makeCtx({ projectDir: "/proj" }), SESSION_ID, options);

    const hop = await cb(
      "codex",
      makeContextBundle(),
      { kind: "swap", failure: SWAP_FAILURE } satisfies HopKind,
      options,
    );

    expect(hop.result.success).toBe(true);
    expect(hop.dispatched).toBe(true);
    // The swap-handoff prompt rewrite still reached the agent: the rebuilt
    // bundle's push markdown is prepended to the original prompt.
    expect(hop.prompt).toBe("## Rebuilt context\n\noriginal prompt");
  });
});

describe("buildHopCallback — timedOut overrides keepOpen in the finally", () => {
  test("keepOpen:true still closes the session when the turn timed out", async () => {
    const sessionManager = makeSessionManager({
      openSession: mock(async () => makeHandle("nax-timeout")),
      closeSession: mock(async () => {}),
    });
    const agentManager = makeMockAgentManager({
      runAsSessionFn: mock(async () => makeStubTurnResult({ timedOut: true })),
    });
    const options = makeBaseOptions({ keepOpen: true });
    const cb = buildHopCallback(makeCtx({ sessionManager, agentManager }), SESSION_ID, options);

    const hop = await cb("claude", undefined, { kind: "primary" } satisfies HopKind, options);

    // The turn returned normally (synthesised fail-timeout lives in the result),
    // but the wall-clock-timed-out session is dead — close it despite keepOpen.
    expect(sessionManager.closeSession).toHaveBeenCalledTimes(1);
    expect(hop.result.success).toBe(true);
  });
});
