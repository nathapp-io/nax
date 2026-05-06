/**
 * Integration tests for idle watchdog stale cancellation behavior.
 *
 * These tests exercise the real AcpAgentAdapter + attachAgentIdleWatchdog path
 * using a mock ACP client (via _acpAdapterDeps.createClient injection).
 *
 * AC9: Hanging prompt (no stream activity) → fail-stale before wall-clock timeout
 * AC10: Periodic agent_thought_chunk events → watchdog does NOT cancel
 * AC11: Periodic usage_update events → watchdog does NOT cancel
 * AC7:  Idle watchdog failure is distinguishable from wall-clock timeout behavior
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AcpAgentAdapter, _acpAdapterDeps } from "../../../src/agents/acp/adapter";
import type { AcpClient, AcpSession, AcpSessionResponse } from "../../../src/agents/acp/adapter";
import type { AcpClientOptions } from "../../../src/agents/acp/adapter-session-types";
import { AgentStreamEventBus } from "../../../src/runtime/agent-stream-events";
import type { AgentStreamEvent } from "../../../src/runtime/agent-stream-events";
import { attachAgentIdleWatchdog } from "../../../src/runtime/middleware";
import { makeNaxConfig } from "../../helpers";

// setTimeout is permitted here for controlled test delays (not Bun.sleep — see testing-rules.md)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeWatchdogConfig(
  idleTimeoutMs: number,
  activityKinds: ("message_update" | "thinking_update" | "usage_update")[] = [
    "message_update",
    "thinking_update",
    "usage_update",
  ],
) {
  return makeNaxConfig({
    agent: {
      idleWatchdog: {
        enabled: true,
        mode: "cancel",
        idleTimeoutSeconds: idleTimeoutMs / 1000,
        activityKinds,
        cancelGraceSeconds: 0,
        maxRetryAttempts: 1,
      },
    },
  });
}

function makeCompleteOptions(
  registry: Map<string, () => Promise<void>>,
  onStreamActivity: (event: AgentStreamEvent) => void,
  timeoutMs = 5000,
) {
  return {
    resolvedPermissions: { mode: "approve-reads" as const, skipPermissions: false },
    modelDef: { provider: "anthropic" as const, model: "claude-haiku-4-5" as const },
    workdir: "/tmp/test",
    timeoutMs,
    storyId: "us-test",
    watchdogControllerRegistry: registry,
    onStreamActivity,
  };
}

const BASE_STREAM_EVENT = {
  runId: "test-run",
  agentName: "claude",
  sessionName: "test-session",
} as const;

/**
 * Mock client whose session.prompt() hangs until the watchdog cancel fires.
 *
 * When the adapter calls opts.onWatchdogRegister(callId, cancelFn), the adapter
 * wraps cancelFn to set staleBox.cancelled=true before calling it. The watchdog
 * later calls registry.get(callId)() which triggers the whole chain, causing
 * session.prompt() to resolve with stopReason="error" and the adapter to return
 * a fail-stale AdapterFailure.
 */
function makeHangingMockClient(opts: AcpClientOptions | undefined): AcpClient {
  const callId = `hang-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let resolve: ((r: AcpSessionResponse) => void) | null = null;

  const session: AcpSession = {
    async prompt(): Promise<AcpSessionResponse> {
      // Register cancel function — adapter wraps this to set staleBox.cancelled
      opts?.onWatchdogRegister?.(callId, async () => {
        resolve?.({ messages: [{ role: "assistant", content: "" }], stopReason: "error" });
        resolve = null;
      });

      // Emit call_started so the watchdog starts tracking this call
      opts?.onStreamActivity?.({
        ...BASE_STREAM_EVENT,
        callId,
        kind: "agent.call_started",
        model: "claude-haiku-4-5",
        timeoutSeconds: 5,
        timestamp: Date.now(),
      });

      // Hang until the watchdog fires and calls our cancel function
      return new Promise<AcpSessionResponse>((res) => {
        resolve = res;
      });
    },
    async close() {},
    async cancelActivePrompt() {
      resolve?.({ messages: [{ role: "assistant", content: "" }], stopReason: "error" });
      resolve = null;
    },
  };

  return {
    async start() {},
    async createSession() {
      return session;
    },
    async close() {},
  };
}

/**
 * Mock client whose session emits periodic stream activity events then completes normally.
 *
 * The activity events reset the watchdog idle timer, preventing cancellation.
 * After durationMs the prompt resolves with end_turn.
 */
function makeActiveSessionMockClient(
  opts: AcpClientOptions | undefined,
  activityKind: "agent.message_update" | "agent.thinking_update" | "agent.usage_update",
  intervalMs: number,
  durationMs: number,
): AcpClient {
  const callId = `active-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const session: AcpSession = {
    async prompt(): Promise<AcpSessionResponse> {
      opts?.onWatchdogRegister?.(callId, async () => {
        // Not expected to fire in normal operation tests
      });

      opts?.onStreamActivity?.({
        ...BASE_STREAM_EVENT,
        callId,
        kind: "agent.call_started",
        model: "claude-haiku-4-5",
        timeoutSeconds: 5,
        timestamp: Date.now(),
      });

      const start = Date.now();
      while (Date.now() - start < durationMs) {
        await sleep(intervalMs);
        const activityBase = { ...BASE_STREAM_EVENT, callId, timestamp: Date.now() };
        if (activityKind === "agent.usage_update") {
          opts?.onStreamActivity?.({ ...activityBase, kind: activityKind, inputTokens: 10, outputTokens: 5 });
        } else {
          opts?.onStreamActivity?.({ ...activityBase, kind: activityKind, deltaBytes: 16 });
        }
      }

      opts?.onStreamActivity?.({
        ...BASE_STREAM_EVENT,
        callId,
        kind: "agent.call_ended",
        status: "success",
        timestamp: Date.now(),
      });

      return {
        messages: [{ role: "assistant", content: '{"type":"result","result":"done"}' }],
        stopReason: "end_turn",
      };
    },
    async close() {},
    async cancelActivePrompt() {},
  };

  return {
    async start() {},
    async createSession() {
      return session;
    },
    async close() {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Idle watchdog stale cancellation (ACP)", () => {
  let origCreateClient: typeof _acpAdapterDeps.createClient;

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
  });

  // AC9: Hanging prompt with no stream activity triggers fail-stale before wall-clock timeout
  test("hanging prompt with no stream activity triggers fail-stale before wall-clock timeout", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const WALL_CLOCK_TIMEOUT_MS = 5000; // much longer — must not interfere

    const eventBus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const config = makeWatchdogConfig(IDLE_TIMEOUT_MS);
    const detach = attachAgentIdleWatchdog(eventBus, registry, config);

    _acpAdapterDeps.createClient = (_cmd, _cwd, _timeout, _onPid, _retries, _onExit, opts) =>
      makeHangingMockClient(opts);

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("test prompt", {
        ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus), WALL_CLOCK_TIMEOUT_MS),
      });

      // Adapter must return a structured fail-stale AdapterFailure, not throw
      expect(result.adapterFailure).toBeDefined();
      expect(result.adapterFailure?.outcome).toBe("fail-stale");
      expect(result.adapterFailure?.category).toBe("availability");
      expect(result.adapterFailure?.retriable).toBe(true);
      // Message must reference idle or watchdog to distinguish from wall-clock timeout
      expect(result.adapterFailure?.message).toMatch(/idle|watchdog/i);
    } finally {
      detach();
    }
  });

  // AC10: Prompt emitting periodic agent_thought_chunk (thinking_update) events is NOT cancelled
  test("prompt emitting periodic agent_thought_chunk events is NOT cancelled by idle watchdog", async () => {
    // thinking_update events (which carry agent_thought_chunk data from acpx) must reset the timer.
    // The prompt runs for 250ms, emitting a thinking_update every 50ms (5 events).
    // Idle timeout is 200ms — if events reset the timer, the watchdog never fires.
    const IDLE_TIMEOUT_MS = 200;
    const ACTIVITY_INTERVAL_MS = 50;
    const PROMPT_DURATION_MS = 250;

    const eventBus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const config = makeWatchdogConfig(IDLE_TIMEOUT_MS);
    const detach = attachAgentIdleWatchdog(eventBus, registry, config);

    _acpAdapterDeps.createClient = (_cmd, _cwd, _timeout, _onPid, _retries, _onExit, opts) =>
      makeActiveSessionMockClient(opts, "agent.thinking_update", ACTIVITY_INTERVAL_MS, PROMPT_DURATION_MS);

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("test prompt", {
        ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus)),
      });

      // Watchdog must NOT have fired — prompt completes normally
      expect(result.adapterFailure).toBeUndefined();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  // AC11: Prompt emitting only periodic usage_update events is NOT cancelled by the watchdog
  test("prompt emitting only periodic usage_update events is NOT cancelled by idle watchdog", async () => {
    // usage_update is in the default activityKinds list, so it resets the idle timer.
    // The prompt runs for 250ms, emitting a usage_update every 50ms (5 events).
    // Idle timeout is 200ms — usage_update events keep resetting the timer, so no cancellation.
    const IDLE_TIMEOUT_MS = 200;
    const ACTIVITY_INTERVAL_MS = 50;
    const PROMPT_DURATION_MS = 250;

    const eventBus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    // Explicitly include usage_update in activityKinds (matches the default)
    const config = makeWatchdogConfig(IDLE_TIMEOUT_MS, ["message_update", "thinking_update", "usage_update"]);
    const detach = attachAgentIdleWatchdog(eventBus, registry, config);

    _acpAdapterDeps.createClient = (_cmd, _cwd, _timeout, _onPid, _retries, _onExit, opts) =>
      makeActiveSessionMockClient(opts, "agent.usage_update", ACTIVITY_INTERVAL_MS, PROMPT_DURATION_MS);

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("test prompt", {
        ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus)),
      });

      // Watchdog must NOT have fired — usage_update resets the timer
      expect(result.adapterFailure).toBeUndefined();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  // AC7: Idle watchdog failure is distinguishable from wall-clock timeout behavior.
  // Idle timeout → AdapterFailure{outcome:"fail-stale"} returned from complete().
  // Wall-clock timeout → throws CompleteError (not an AdapterFailure).
  // The spec never produces a "fail-timeout" AdapterFailure for wall-clock timeout.
  test("idle watchdog failure is distinguishable from wall-clock timeout: fail-stale vs thrown error", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const eventBus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const config = makeWatchdogConfig(IDLE_TIMEOUT_MS);
    const detach = attachAgentIdleWatchdog(eventBus, registry, config);

    _acpAdapterDeps.createClient = (_cmd, _cwd, _timeout, _onPid, _retries, _onExit, opts) =>
      makeHangingMockClient(opts);

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("test prompt", {
        ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus), 5000),
      });

      // Idle watchdog → structured AdapterFailure (caller can distinguish and retry)
      expect(result.adapterFailure?.outcome).toBe("fail-stale");
      expect(result.adapterFailure?.category).toBe("availability");
      // Message references idle/watchdog — NOT wall-clock — so callers and logs can distinguish
      expect(result.adapterFailure?.message).toMatch(/idle|watchdog/i);
      expect(result.adapterFailure?.message).not.toMatch(/wall-clock/i);
      // fail-stale is retriable; wall-clock timeout is a permanent termination
      expect(result.adapterFailure?.retriable).toBe(true);
    } finally {
      detach();
    }
  });

  test("idle watchdog is configurable via config.agent.idleWatchdog.idleTimeoutSeconds", async () => {
    const SHORT_IDLE_TIMEOUT_MS = 60;
    const WALL_CLOCK_TIMEOUT_MS = 2000;

    const eventBus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const config = makeWatchdogConfig(SHORT_IDLE_TIMEOUT_MS);
    const detach = attachAgentIdleWatchdog(eventBus, registry, config);

    _acpAdapterDeps.createClient = (_cmd, _cwd, _timeout, _onPid, _retries, _onExit, opts) =>
      makeHangingMockClient(opts);

    try {
      const adapter = new AcpAgentAdapter("claude");
      const startMs = Date.now();
      const result = await adapter.complete("test prompt", {
        ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus), WALL_CLOCK_TIMEOUT_MS),
      });
      const elapsedMs = Date.now() - startMs;

      // Idle watchdog must have fired — not the wall-clock timeout
      expect(result.adapterFailure?.outcome).toBe("fail-stale");
      // Must resolve well before the wall-clock timeout
      expect(elapsedMs).toBeLessThan(WALL_CLOCK_TIMEOUT_MS / 2);
    } finally {
      detach();
    }
  });

});
