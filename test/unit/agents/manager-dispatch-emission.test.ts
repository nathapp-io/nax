/**
 * Single-emission invariant tests for the three dispatch boundaries + envelopes.
 *
 * Verifies that each call path emits exactly the right number of DispatchEvents
 * and OperationCompletedEvents. This is the ADR-020 Wave 1 contract: one typed
 * event per logical dispatch, no duplicate emission, no silent gaps.
 *
 * Boundaries under test:
 *   - runAsSession       → one SessionTurnDispatchEvent (origin:"runAsSession")
 *   - completeAs         → one CompleteDispatchEvent
 *   - runWithFallback    → N SessionTurnDispatchEvents + one OperationCompletedEvent
 *   - runAs envelope     → zero DispatchEvents + one OperationCompletedEvent
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type DeepPartial, makeAgentAdapter, makeContextBundle, makeNaxConfig } from "@test/helpers";
import { _acpAdapterDeps } from "@/agents/acp/adapter";
import { AgentManager } from "@/agents/manager";
import { buildSessionTurnEvent } from "@/agents/manager-dispatch";
import type { RunAsSessionOpts } from "@/agents/manager-types";
import { _registryTestAdapters, createAgentRegistry } from "@/agents/registry";
import type { AgentAdapter, SessionHandle, TurnResult } from "@/agents/types";
import { resolveDefaultAgent } from "@/agents/utils";
import { agentManagerConfigSelector, DEFAULT_AGENT_NAME, DEFAULT_CONFIG } from "@/config";
import { resolvePermissions } from "@/config/permissions";
import { NaxConfigSchema } from "@/config/schemas";
import type { AgentManagerConfig } from "@/config/selectors";
import type { NaxConfig } from "@/config/types";
import type {
  CompleteDispatchEvent,
  DispatchErrorEvent,
  OperationCompletedEvent,
  SessionTurnDispatchEvent,
} from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { makeClient, makeSession } from "./acp/adapter.test";

// ─── Shared helpers ─────────────────────────────────────────────────────────

function makeTurnResult(output = "ok"): TurnResult {
  return {
    output,
    tokenUsage: { inputTokens: 10, outputTokens: 5 },
    estimatedCostUsd: 0.001,
    exactCostUsd: 0.001,
    internalRoundTrips: 1,
  };
}

function makeFallbackConfig(): NaxConfig {
  return NaxConfigSchema.parse({
    agent: {
      default: "claude",
      fallback: {
        enabled: true,
        map: { claude: ["codex"] },
        maxHopsPerStory: 2,
        onQualityFailure: false,
        rebuildContext: true,
      },
    },
  }) as NaxConfig;
}

function makeHandle(agentName = "claude", id = "nax-test-handle"): SessionHandle {
  return { id, agentName };
}

function makeHandleWithIds(
  agentName = "claude",
  id = "nax-test-handle",
  protocolIds?: { sessionId: string | null; recordId: string | null },
): SessionHandle {
  return { id, agentName, ...(protocolIds && { protocolIds }) };
}

// ─── runAsSession ────────────────────────────────────────────────────────────

describe("runAsSession — dispatch emission", () => {
  test("emits exactly one session-turn event with origin:runAsSession", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => makeTurnResult("hello")),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    await manager.runAsSession("claude", makeHandle(), "test-prompt", {
      pipelineStage: "run",
      storyId: "US-001",
      featureName: "my-feat",
      workdir: "/tmp/repo",
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.origin).toBe("runAsSession");
    expect(received[0]?.agentName).toBe("claude");
    expect(received[0]?.storyId).toBe("US-001");
    expect(received[0]?.featureName).toBe("my-feat");
    expect(received[0]?.workdir).toBe("/tmp/repo");
    expect(received[0]?.prompt).toBe("test-prompt");
  });

  test("forwards handle.protocolIds.recordId into session-turn event", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => makeTurnResult("hello")),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    const handle = makeHandleWithIds("claude", "nax-test-handle", {
      sessionId: "sess-abc",
      recordId: "rec-xyz",
    });
    await manager.runAsSession("claude", handle, "p", { pipelineStage: "run", storyId: "US-001" });

    expect(received).toHaveLength(1);
    expect(received[0]?.protocolIds.sessionId).toBe("sess-abc");
    expect(received[0]?.protocolIds.recordId).toBe("rec-xyz");
  });

  test("mints a turnId before sendPrompt and stamps the same value on the event", async () => {
    const bus = new DispatchEventBus();
    const sendPrompt = mock(async (_handle: SessionHandle, _prompt: string, _opts: RunAsSessionOpts) =>
      makeTurnResult("hello"),
    );
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, { sendPrompt, dispatchEvents: bus });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    await manager.runAsSession("claude", makeHandle(), "test-prompt", {
      pipelineStage: "run",
      storyId: "US-turn",
    });

    const passedOpts = sendPrompt.mock.calls[0]?.[2];
    expect(passedOpts?.turnId).toBeTruthy();
    expect(received[0]?.protocolIds.turnId).toBe(passedOpts?.turnId);
  });

  test("stamps the minted turnId on the DispatchErrorEvent when the turn throws", async () => {
    const bus = new DispatchEventBus();
    const sendPrompt = mock(async (_handle: SessionHandle, _prompt: string, _opts: RunAsSessionOpts) => {
      throw new Error("network failure");
    });
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, { sendPrompt, dispatchEvents: bus });

    const errors: DispatchErrorEvent[] = [];
    bus.onDispatchError((e) => errors.push(e));

    await expect(manager.runAsSession("claude", makeHandle(), "prompt", { pipelineStage: "run" })).rejects.toThrow(
      "network failure",
    );

    const passedOpts = sendPrompt.mock.calls[0]?.[2];
    expect(passedOpts?.turnId).toBeTruthy();
    expect(errors[0]?.turnId).toBe(passedOpts?.turnId);
  });

  test("forwards estimatedCostUsd on session-turn events when exactCostUsd is absent", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => ({
        output: "hello",
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        estimatedCostUsd: 0.001,
        exactCostUsd: undefined,
        internalRoundTrips: 1,
      })),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    await manager.runAsSession("claude", makeHandle(), "test-prompt", {
      pipelineStage: "run",
      storyId: "US-001",
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.estimatedCostUsd).toBe(0.001);
    expect(received[0]?.exactCostUsd).toBeUndefined();
  });

  test("forwards TurnResult.interactions onto the session-turn event (issue #1226)", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => ({
        ...makeTurnResult("final answer"),
        internalRoundTrips: 2,
        interactions: [
          { turnIndex: 1, question: "fix fixture or accept 15/17?", reply: "raise testEditDeclaration escalation" },
        ],
      })),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    await manager.runAsSession("claude", makeHandle(), "test-prompt", {
      pipelineStage: "run",
      storyId: "US-004",
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.interactions).toEqual([
      { turnIndex: 1, question: "fix fixture or accept 15/17?", reply: "raise testEditDeclaration escalation" },
    ]);
  });

  test("omits interactions on the session-turn event when TurnResult has none", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => makeTurnResult("plain")),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    await manager.runAsSession("claude", makeHandle(), "p", { pipelineStage: "run", storyId: "US-005" });

    expect(received).toHaveLength(1);
    expect(received[0]?.interactions).toBeUndefined();
  });

  test("emits DispatchErrorEvent on sendPrompt throw, then re-throws", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => {
        throw new Error("network failure");
      }),
      dispatchEvents: bus,
    });

    const errors: string[] = [];
    bus.onDispatchError((e) => errors.push(e.errorMessage));

    await expect(manager.runAsSession("claude", makeHandle(), "prompt", { pipelineStage: "run" })).rejects.toThrow(
      "network failure",
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("network failure");
  });
});

// ─── completeAs ─────────────────────────────────────────────────────────────

describe("completeAs — dispatch emission", () => {
  const origCreateClient = _acpAdapterDeps.createClient;
  beforeEach(() => {
    _acpAdapterDeps.createClient = mock(() => makeClient(makeSession()));
  });
  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    mock.restore();
  });

  test("emits exactly one complete event", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, { dispatchEvents: bus });

    const received: CompleteDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "complete") received.push(e);
    });

    await manager.completeAs("claude", "summarise this", {
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6", env: {} },
      workdir: "/tmp/test",
      storyId: "US-003",
      sessionRole: "reviewer-adversarial",
      pipelineStage: "complete",
      timeoutMs: 100,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.kind).toBe("complete");
    expect(received[0]?.sessionRole).toBe("reviewer-adversarial");
    expect(received[0]?.storyId).toBe("US-003");
  });
});

// ─── runWithFallback — 2 hops via executeHop → runAsSession ─────────────────

describe("runWithFallback — multi-hop dispatch emission", () => {
  test("2 hops emit two session-turn events + one OperationCompletedEvent (fallbackTriggered:true)", async () => {
    const config = makeFallbackConfig();
    const bus = new DispatchEventBus();
    const manager = new AgentManager(config, undefined, {
      sendPrompt: mock(async () => makeTurnResult("hop-result")),
      dispatchEvents: bus,
    });

    const sessionTurns: SessionTurnDispatchEvent[] = [];
    const opCompleted: OperationCompletedEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") sessionTurns.push(e);
    });
    bus.onOperationCompleted((e) => opCompleted.push(e));

    // shouldSwap requires hasBundle:true — provide a minimal stub bundle.
    const fakeBundle = makeContextBundle();

    let hopCount = 0;
    await manager.runWithFallback({
      runOptions: {
        prompt: "do work",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        timeoutSeconds: 30,
        config,
        storyId: "US-hop",
        pipelineStage: "run",
      },
      bundle: fakeBundle,
      executeHop: async (agentName) => {
        hopCount++;
        const handle = makeHandle(agentName, `handle-hop-${hopCount}`);
        // Call runAsSession so the dispatch event is emitted.
        const turn = await manager.runAsSession(agentName, handle, "do work", {
          pipelineStage: "run",
          storyId: "US-hop",
        });
        if (hopCount === 1) {
          return {
            result: {
              success: false,
              exitCode: 1,
              output: turn.output,
              rateLimited: false,
              durationMs: 10,
              estimatedCostUsd: 0,
              adapterFailure: {
                category: "availability" as const,
                outcome: "fail-auth" as const,
                retriable: false,
                message: "",
              },
            },
            bundle: fakeBundle,
            prompt: "do work",
          };
        }
        return {
          result: {
            success: true,
            exitCode: 0,
            output: turn.output,
            rateLimited: false,
            durationMs: 20,
            estimatedCostUsd: 0,
          },
          bundle: fakeBundle,
          prompt: "do work",
        };
      },
    });

    expect(sessionTurns).toHaveLength(2);
    expect(sessionTurns[0]?.origin).toBe("runAsSession");
    expect(sessionTurns[1]?.origin).toBe("runAsSession");
    expect(opCompleted).toHaveLength(1);
    expect(opCompleted[0]?.fallbackTriggered).toBe(true);
    expect(opCompleted[0]?.hopCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── runAs envelope — zero DispatchEvent, one OperationCompletedEvent ────────

describe("runAs envelope — no per-dispatch event, one OperationCompletedEvent", () => {
  test("runAs with runHop (no runAsSession) emits zero DispatchEvents and one OperationCompletedEvent", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      runHop: mock(async () => ({
        prompt: "p",
        result: {
          success: true,
          exitCode: 0,
          output: "done",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
        },
      })),
      dispatchEvents: bus,
    });

    const dispatched: unknown[] = [];
    const opCompleted: OperationCompletedEvent[] = [];
    bus.onDispatch((e) => dispatched.push(e));
    bus.onOperationCompleted((e) => opCompleted.push(e));

    await manager.runAs("claude", {
      runOptions: {
        prompt: "p",
        workdir: "/tmp",
        modelTier: "fast",
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        timeoutSeconds: 30,
        config: DEFAULT_CONFIG,
        storyId: "US-004",
      },
    });

    expect(dispatched).toHaveLength(0);
    expect(opCompleted).toHaveLength(1);
    expect(opCompleted[0]?.finalStatus).toBe("ok");
  });
});

// ─── #1433: model attribution on dispatch events ─────────────────────────────

describe("dispatch events carry the model (#1433)", () => {
  test("runAsSession stamps the model the session was opened with", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => makeTurnResult("hello")),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    const handle: SessionHandle = {
      id: "nax-test-handle",
      agentName: "claude",
      modelDef: { provider: "anthropic", model: "haiku" },
      modelTier: "fast",
    };
    await manager.runAsSession("claude", handle, "p", { pipelineStage: "run", storyId: "US-001" });

    expect(received[0]?.model).toBe("haiku");
    expect(received[0]?.modelTier).toBe("fast");
  });

  test("runAsSession omits model when the handle carries none", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => makeTurnResult("hello")),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    // Pre-#1433 handles (and test doubles) have no modelDef. The field must stay
    // absent rather than becoming a fabricated value.
    await manager.runAsSession("claude", makeHandle(), "p", { pipelineStage: "run" });

    expect(received[0]?.model).toBeUndefined();
    expect(received[0]?.modelTier).toBeUndefined();
  });

  test("stamps the resolved run profile from config", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager({ ...DEFAULT_CONFIG, profile: "cc-acceptance" }, undefined, {
      sendPrompt: mock(async () => makeTurnResult("hello")),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    await manager.runAsSession("claude", makeHandle(), "p", { pipelineStage: "run" });

    expect(received[0]?.profile).toBe("cc-acceptance");
  });
});

// ─── #1464: modelAttribution decomposes the effort suffix ──────────────────

describe("dispatch events decompose the effort suffix (#1464)", () => {
  test("runAsSession emits the bare model plus effort for a suffixed spec", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => makeTurnResult("hello")),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    const handle: SessionHandle = {
      id: "nax-test-handle",
      agentName: "codex",
      modelDef: { provider: "openai", model: "gpt-5.6-luna[high]" },
    };
    await manager.runAsSession("codex", handle, "p", { pipelineStage: "run", storyId: "US-006" });

    expect(received[0]?.model).toBe("gpt-5.6-luna");
    expect(received[0]?.effort).toBe("high");
  });

  test("runAsSession omits effort entirely for a bare model spec", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => makeTurnResult("hello")),
      dispatchEvents: bus,
    });

    const received: SessionTurnDispatchEvent[] = [];
    bus.onDispatch((e) => {
      if (e.kind === "session-turn") received.push(e);
    });

    const handle: SessionHandle = {
      id: "nax-test-handle",
      agentName: "claude",
      modelDef: { provider: "anthropic", model: "haiku" },
    };
    await manager.runAsSession("claude", handle, "p", { pipelineStage: "run", storyId: "US-007" });

    expect(received[0]?.model).toBe("haiku");
    expect("effort" in (received[0] ?? {})).toBe(false);
  });
});

// ─── tier 3: per-turn identity ───────────────────────────────────────────────

describe("buildSessionTurnEvent — turnId (tier 3)", () => {
  test("carries a supplied turnId on protocolIds", () => {
    const handle: SessionHandle = { id: "nax-test-handle", agentName: "claude" };
    const result: TurnResult = makeTurnResult("ok");

    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "claude",
      stage: "run",
      opts: { pipelineStage: "run", storyId: "US-turn" },
      resolvedPermissions: resolvePermissions(DEFAULT_CONFIG, "run"),
      startedAt: 1_000,
      turnId: "turn-1",
    });

    expect(event.protocolIds.turnId).toBe("turn-1");
  });

  test("omits turnId on protocolIds when none is supplied", () => {
    const handle: SessionHandle = { id: "nax-test-handle", agentName: "claude" };
    const result: TurnResult = makeTurnResult("ok");

    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "claude",
      stage: "run",
      opts: { pipelineStage: "run" },
      resolvedPermissions: resolvePermissions(DEFAULT_CONFIG, "run"),
      startedAt: 1_000,
    });

    expect("turnId" in event.protocolIds).toBe(false);
  });
});

// ─── narrowed config (Pick<NaxConfig, 'agent' | 'execution'>) ────────────────

const makeSlicedConfig = (
  agent: DeepPartial<NaxConfig["agent"]> = {},
  execution: DeepPartial<NaxConfig["execution"]> = {},
): AgentManagerConfig => agentManagerConfigSelector.select(makeNaxConfig({ agent, execution }));

describe("AgentManager — narrowed config (Pick<NaxConfig, 'agent' | 'execution'>)", () => {
  describe("resolveDefaultAgent", () => {
    test("returns default agent from config", () => {
      const config = makeSlicedConfig({ default: "codex" });
      expect(resolveDefaultAgent(config)).toBe("codex");
    });

    test("returns fallback when default is empty", () => {
      const config = makeSlicedConfig({ default: "" });
      expect(resolveDefaultAgent(config)).toBe(DEFAULT_AGENT_NAME);
    });

    test("returns fallback when no agent config", () => {
      const config = makeSlicedConfig({});
      expect(resolveDefaultAgent(config)).toBe(DEFAULT_AGENT_NAME);
    });
  });

  describe("createAgentRegistry", () => {
    let mockAdapter: AgentAdapter;

    beforeEach(() => {
      mockAdapter = makeAgentAdapter({ name: "mock", displayName: "Mock Agent", binary: "mock" });
    });

    afterEach(() => {
      _registryTestAdapters.delete("mock");
    });

    test("creates registry with sliced config", () => {
      const config = makeSlicedConfig({ default: "mock", protocol: "acp" });
      const registry = createAgentRegistry(config);
      expect(registry.protocol).toBe("acp");
    });

    test("creates registry with sliced config — safe with no agent.default", () => {
      const config = makeSlicedConfig({ protocol: "acp" }); // no default, no agent
      const registry = createAgentRegistry(config);
      expect(registry.protocol).toBe("acp");
    });

    test("test adapter takes precedence in registry", () => {
      _registryTestAdapters.set("mock", mockAdapter);
      const config = makeSlicedConfig({});
      const registry = createAgentRegistry(config);
      expect(registry.getAgent("mock")).toBe(mockAdapter);
    });

    test("returns undefined for unknown agent", () => {
      const config = makeSlicedConfig({});
      const registry = createAgentRegistry(config);
      expect(registry.getAgent("nonexistent")).toBeUndefined();
    });
  });
});
