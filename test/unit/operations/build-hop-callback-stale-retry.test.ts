/**
 * Unit tests — buildHopCallback hop mechanics: session reuse, run counters,
 * pull-budget registration, handoff, and model/tier resolution when a hop runs
 * on an agent the caller's pin does not belong to.
 *
 * stale-retry session reuse (#977): on `{ kind: "stale-retry" }` getLiveHandle
 * finds the cached handle, openSession/closeSession are skipped; on
 * `{ kind: "primary" }`/`{ kind: "swap" }` openSession IS called and
 * closeSession IS called in the finally block.
 *
 * Pinned model re-resolution (nax#1722): found by the `fallback-probe` smoke
 * run, not by the suite — `resolveStartAgent` starts an operation on a
 * fallback agent when the primary is already unavailable, and that hop is
 * still `{ kind: "primary" }`. The caller resolved `modelDef` for the PRIMARY,
 * so carrying it onto the substituted agent produced `acpx --model haiku ...
 * codex`, which the ACP agent rejects outright. `pinnedModelAgent` names the
 * agent the pin was resolved for; any other agent re-resolves from its own
 * tier map.
 *
 * Tier/model id resolution: the run path resolves its model HERE in the caller
 * (unlike the complete path, which re-resolves inside the manager via
 * modelDefFor), and `{ agent, model }` may name a tier OR a literal model id —
 * a literal pin reaches here with `model` set and the tier lookup cannot serve
 * it. Covering only one leaves `{ agent, tier }` working for complete ops and
 * silently ignored for run ops (or vice versa).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeContextBundle, makeMockAgentManager, makeNaxConfig, makeSessionManager, makeStory } from "@test/helpers";
import type { AgentRunOptions, SessionHandle, TurnResult } from "@/agents/types";
import { resolveModel, resolveModelForAgent } from "@/config";
import type { AdapterFailure } from "@/context/engine";
import { _buildHopCallbackDeps, buildHopCallback } from "@/operations";
import type { BuildHopCallbackContext } from "@/operations/build-hop-callback";
import { hopModelId, hopTier } from "@/operations/build-hop-callback";
import type { OpenSessionRequest, SessionDescriptor } from "@/session/types";

// ─────────────────────────────────────────────────────────────────────────────
// Shared stubs
// ─────────────────────────────────────────────────────────────────────────────

const STUB_HANDLE: SessionHandle = { id: "nax-abc123", agentName: "claude" };

const SWAP_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-auth",
  retriable: false,
  message: "401",
};

const STUB_TURN: TurnResult = {
  output: "done",
  tokenUsage: { inputTokens: 10, outputTokens: 5 },
  estimatedCostUsd: 0.001,
  internalRoundTrips: 1,
};

const HANDOFF_DESCRIPTOR: SessionDescriptor = {
  id: "session-1",
  role: "main",
  state: "RUNNING",
  agent: "codex",
  workdir: "/tmp",
  protocolIds: { recordId: null, sessionId: null },
  completedStages: [],
  createdAt: new Date(0).toISOString(),
  lastActivityAt: new Date(0).toISOString(),
};

const STUB_RUN_OPTIONS: AgentRunOptions = {
  prompt: "do the thing",
  workdir: "/tmp",
  modelTier: "balanced",
  modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
  storyId: "US-001",
  sessionRole: "implementer",
  timeoutSeconds: 30,
  config: makeNaxConfig(),
};

const PIN_STUB_TURN: TurnResult = {
  output: "done",
  tokenUsage: { inputTokens: 1, outputTokens: 1 },
  estimatedCostUsd: 0,
  internalRoundTrips: 1,
};

const PIN_MODELS = {
  claude: { balanced: { provider: "anthropic", model: "haiku" } },
  codex: { balanced: { provider: "openai", model: "gpt-5.6-luna" } },
};

// ─────────────────────────────────────────────────────────────────────────────
// Dep injection save/restore
// ─────────────────────────────────────────────────────────────────────────────

let origCreateContextToolRuntime: typeof _buildHopCallbackDeps.createContextToolRuntime;
let origRebuildForAgent: typeof _buildHopCallbackDeps.rebuildForAgent;

beforeEach(() => {
  origCreateContextToolRuntime = _buildHopCallbackDeps.createContextToolRuntime;
  origRebuildForAgent = _buildHopCallbackDeps.rebuildForAgent;
  // Suppress context tool runtime creation — not relevant to session reuse tests.
  _buildHopCallbackDeps.createContextToolRuntime = () => undefined;
  _buildHopCallbackDeps.rebuildForAgent = (prior) => prior;
});

afterEach(() => {
  _buildHopCallbackDeps.createContextToolRuntime = origCreateContextToolRuntime;
  _buildHopCallbackDeps.rebuildForAgent = origRebuildForAgent;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeCtx(sessionMgr: ReturnType<typeof makeSessionManager>) {
  const story = makeStory({ id: "US-001" });
  const config = makeNaxConfig();
  const agentManager = makeMockAgentManager({
    runAsSessionFn: mock(async () => STUB_TURN),
  });
  return {
    sessionManager: sessionMgr,
    agentManager,
    story,
    config,
    projectDir: undefined,
    featureName: "test-feature",
    workdir: "/tmp",
    effectiveTier: "balanced" as const,
    defaultAgent: "claude",
    pipelineStage: "run" as const,
  };
}

function harness(pinnedModelAgent?: string) {
  const config = makeNaxConfig({ models: PIN_MODELS });
  // Record the model the session was opened with rather than casting mock.calls back
  // into a shape — the adapter's own signature types it.
  const opened: string[] = [];
  const sessionManager = makeSessionManager({
    openSession: mock(async (name: string, opts: OpenSessionRequest) => {
      opened.push(opts.modelDef.model);
      return { id: name, agentName: opts.agentName } satisfies SessionHandle;
    }),
    closeSession: mock(async () => {}),
  });
  const ctx: BuildHopCallbackContext = {
    sessionManager,
    agentManager: makeMockAgentManager({ runAsSessionFn: mock(async () => PIN_STUB_TURN) }),
    story: makeStory({ id: "US-001" }),
    config,
    featureName: "fallback-probe",
    workdir: "/tmp/nax-model-pin",
    effectiveTier: "balanced",
    defaultAgent: "claude",
    pipelineStage: "run",
    ...(pinnedModelAgent !== undefined && { pinnedModelAgent }),
  };
  const options: AgentRunOptions = {
    prompt: "do the work",
    workdir: "/tmp/nax-model-pin",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "haiku" },
    timeoutSeconds: 30,
    config,
  };
  return { ctx, options, opened };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

// Gap finding 7 — the pull budget registry must be created ONCE per callback,
// outside the returned closure. Created inside, every retry / fallback /
// escalation hop got a fresh registry and maxCallsPerSession reset to zero.
// Nothing else in the suite pins this placement.
// Gap finding 7 / AC-18: BuildHopCallbackContext declared contextToolRunCounter
// but no production site populated it — call.ts's hopCtx literal omitted it,
// and could not gain the line because the file sat at its grandfathered
// size ceiling (cleared by #1460). So the run cap reset every hop and pull
// invocations were never recorded anywhere.
describe("buildHopCallback — run counter threading", () => {
  test("forwards the run counter it was given, instead of minting a fresh one", async () => {
    const seen: unknown[] = [];
    _buildHopCallbackDeps.createContextToolRuntime = (opts: { runCounter?: unknown }) => {
      seen.push(opts.runCounter);
      return undefined;
    };
    const counter = { count: 7, calls: [] };
    const sessionMgr = makeSessionManager({});
    const ctx: BuildHopCallbackContext = {
      ...makeCtx(sessionMgr),
      contextToolRunCounter: counter,
      pipelineStage: "run",
    };
    const cb = buildHopCallback(ctx, undefined, STUB_RUN_OPTIONS);

    const bundle = makeContextBundle();
    await cb("claude", bundle, { kind: "primary" }, STUB_RUN_OPTIONS);

    expect(seen[0]).toBe(counter);
  });
});

describe("buildHopCallback — session-scoped pull budget registry", () => {
  test("every hop receives the same sessionBudgets instance", async () => {
    const seen: unknown[] = [];
    _buildHopCallbackDeps.createContextToolRuntime = (opts: { sessionBudgets?: unknown }) => {
      seen.push(opts.sessionBudgets);
      return undefined;
    };
    const sessionMgr = makeSessionManager({});
    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);

    const bundle = makeContextBundle();
    await cb("claude", bundle, { kind: "primary" }, STUB_RUN_OPTIONS);
    await cb("claude", bundle, { kind: "stale-retry", attempt: 2 }, STUB_RUN_OPTIONS);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[0]).toBe(seen[1]);
  });
});

describe("buildHopCallback — stale-retry session reuse", () => {
  test("stale-retry: getLiveHandle called; openSession and closeSession skipped", async () => {
    const getLiveHandle = mock((_name: string) => STUB_HANDLE);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);
    const result = await cb("claude", undefined, { kind: "stale-retry", attempt: 1 }, STUB_RUN_OPTIONS);

    expect(result.result.success).toBe(true);
    expect(getLiveHandle).toHaveBeenCalledTimes(1);
    expect(openSession).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  test("stale-retry cache miss: falls back to openSession, closeSession still skipped", async () => {
    const getLiveHandle = mock((_name: string) => undefined as SessionHandle | undefined);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);
    const result = await cb("claude", undefined, { kind: "stale-retry", attempt: 1 }, STUB_RUN_OPTIONS);

    expect(result.result.success).toBe(true);
    expect(getLiveHandle).toHaveBeenCalledTimes(1);
    expect(openSession).toHaveBeenCalledTimes(1);
    // Even on cache-miss fallback, the handle stays open for the next attempt
    expect(closeSession).not.toHaveBeenCalled();
  });

  test("primary: openSession called, closeSession called, getLiveHandle not called", async () => {
    const getLiveHandle = mock((_name: string) => undefined as SessionHandle | undefined);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);
    const result = await cb("claude", undefined, { kind: "primary" }, STUB_RUN_OPTIONS);

    expect(result.result.success).toBe(true);
    expect(getLiveHandle).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  test("swap: openSession called, closeSession called, getLiveHandle not called", async () => {
    const getLiveHandle = mock((_name: string) => undefined as SessionHandle | undefined);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const cb = buildHopCallback(makeCtx(sessionMgr), undefined, STUB_RUN_OPTIONS);
    const result = await cb("codex", undefined, { kind: "swap", failure: SWAP_FAILURE }, STUB_RUN_OPTIONS);

    expect(result.result.success).toBe(true);
    expect(getLiveHandle).not.toHaveBeenCalled();
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  test("swap: handoff fires with failure outcome; stale-retry does not trigger handoff", async () => {
    const handoff = mock(() => HANDOFF_DESCRIPTOR);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const getLiveHandle = mock((_name: string) => STUB_HANDLE);
    const sessionMgr = makeSessionManager({ handoff, openSession, closeSession, getLiveHandle });

    const cb = buildHopCallback(makeCtx(sessionMgr), "session-1", STUB_RUN_OPTIONS);

    // Stale-retry must NOT fire handoff
    await cb("claude", undefined, { kind: "stale-retry", attempt: 1 }, STUB_RUN_OPTIONS);
    expect(handoff).not.toHaveBeenCalled();

    // Swap MUST fire handoff
    await cb("codex", undefined, { kind: "swap", failure: SWAP_FAILURE }, STUB_RUN_OPTIONS);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(handoff).toHaveBeenCalledWith("session-1", "codex", SWAP_FAILURE.outcome);
  });

  test("closeSession NOT called on stale-retry when send throws (handle stays open for watchdog to cancel)", async () => {
    const getLiveHandle = mock((_name: string) => STUB_HANDLE);
    const openSession = mock(async () => STUB_HANDLE);
    const closeSession = mock(async () => {});
    const sessionMgr = makeSessionManager({ getLiveHandle, openSession, closeSession });

    const agentManager = makeMockAgentManager({
      runAsSessionFn: mock(async () => {
        throw new Error("send failed");
      }),
    });
    const story = makeStory({ id: "US-001" });
    const config = makeNaxConfig();
    const ctx = {
      sessionManager: sessionMgr,
      agentManager,
      story,
      config,
      projectDir: undefined,
      featureName: "f",
      workdir: "/tmp",
      effectiveTier: "balanced" as const,
      defaultAgent: "claude",
      pipelineStage: "run" as const,
    };

    const cb = buildHopCallback(ctx, undefined, STUB_RUN_OPTIONS);
    const result = await cb("claude", undefined, { kind: "stale-retry", attempt: 1 }, STUB_RUN_OPTIONS);

    // Error is caught and returned as failed AgentResult
    expect(result.result.success).toBe(false);
    // Handle must NOT be closed — it stays open for the next hop
    expect(closeSession).not.toHaveBeenCalled();
  });
});

describe("buildHopCallback — pinned model vs dispatching agent", () => {
  test("a primary hop on another agent re-resolves the model from that agent's tier map", async () => {
    const { ctx, options, opened } = harness("claude");

    await buildHopCallback(ctx, "session-1", options)("codex", makeContextBundle(), { kind: "primary" }, options);

    expect(opened[0]).toBe("gpt-5.6-luna");
  });

  test("the pin still applies on the agent it was resolved for", async () => {
    const { ctx, options, opened } = harness("claude");

    await buildHopCallback(ctx, "session-1", options)("claude", makeContextBundle(), { kind: "primary" }, options);

    expect(opened[0]).toBe("haiku");
  });

  test("without pinnedModelAgent the pin is trusted (pre-nax#1722 behaviour for other callers)", async () => {
    const { ctx, options, opened } = harness();

    await buildHopCallback(ctx, "session-1", options)("codex", makeContextBundle(), { kind: "primary" }, options);

    expect(opened[0]).toBe("haiku");
  });
});

describe("hopTier", () => {
  test("a primary hop uses the caller's effective tier", () => {
    expect(hopTier({ kind: "primary" }, "balanced")).toBe("balanced");
  });

  test("a start-on-fallback primary hop that named a tier uses it", () => {
    expect(hopTier({ kind: "primary", tier: "cheap" }, "balanced")).toBe("cheap");
  });

  test("a swap with no tier uses the caller's effective tier", () => {
    expect(hopTier({ kind: "swap", failure: SWAP_FAILURE }, "balanced")).toBe("balanced");
  });

  test("a swap that named a tier uses it", () => {
    expect(hopTier({ kind: "swap", failure: SWAP_FAILURE, tier: "cheap" }, "balanced")).toBe("cheap");
  });

  test("a tierless pinned resolution swaps onto the target's balanced rung (spec §7 last resort)", () => {
    // hop ctx with effectiveTier "balanced" (the call.ts:69 default for a pin, modelTier absent),
    // swap to an agent with a balanced entry, no fallback-map tier for the candidate.
    // Assert the dispatched modelDef is the swap target's balanced entry.
    const tier = hopTier({ kind: "swap", failure: SWAP_FAILURE }, "balanced");
    expect(tier).toBe("balanced");
    const modelDef = resolveModelForAgent(
      {
        claude: { balanced: "claude-sonnet-4-5", powerful: "claude-opus-4-5" },
        native: { cheap: "opencode-go/glm-4-5" },
      },
      "claude",
      tier,
      "claude",
    );
    expect(modelDef.model).toBe("claude-sonnet-4-5");
  });

  test("a timeout retry retains its fallback target's tier", () => {
    expect(hopTier({ kind: "timeout-retry", attempt: 1, tier: "cheap" }, "balanced")).toBe("cheap");
  });

  test("a stale-retry uses the caller's effective tier", () => {
    expect(hopTier({ kind: "stale-retry", attempt: 1 }, "balanced")).toBe("balanced");
  });
});

describe("hopModelId", () => {
  test("a primary hop names no literal model", () => {
    expect(hopModelId({ kind: "primary" })).toBeUndefined();
  });

  test("a swap that named a tier names no literal model", () => {
    expect(hopModelId({ kind: "swap", failure: SWAP_FAILURE, tier: "cheap" })).toBeUndefined();
  });

  test("a swap that named a literal model returns it", () => {
    expect(hopModelId({ kind: "swap", failure: SWAP_FAILURE, model: "openrouter/z-ai/glm-5.3-flash[high]" })).toBe(
      "openrouter/z-ai/glm-5.3-flash[high]",
    );
  });

  test("a start-on-fallback primary hop that named a literal model returns it", () => {
    expect(hopModelId({ kind: "primary", model: "openrouter/z-ai/glm-5.3-flash[high]" })).toBe(
      "openrouter/z-ai/glm-5.3-flash[high]",
    );
  });

  test("a timeout retry retains its fallback target's literal model", () => {
    expect(hopModelId({ kind: "timeout-retry", attempt: 1, model: "openrouter/z-ai/glm-5.3-flash[high]" })).toBe(
      "openrouter/z-ai/glm-5.3-flash[high]",
    );
  });

  test("the literal pin resolves to the same ModelDef the tier map would produce for that id", () => {
    // The dispatched def must be indistinguishable from writing the same id as a
    // `models.native.<tier>` entry — that equivalence is the whole contract of a
    // literal pin, and on the native path the provider is read from the id string
    // (nax#1851), not from ModelDef.provider.
    const id = "openrouter/z-ai/glm-5.3-flash[high]";
    expect(resolveModel(id)).toEqual(resolveModelForAgent({ native: { glm: id } }, "native", "glm", "native"));
  });
});
