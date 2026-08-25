/**
 * Integration tests for idle watchdog stale cancellation at the adapter boundary.
 *
 * These tests exercise the real AcpAgentAdapter + attachAgentIdleWatchdog path
 * using a mock ACP client (via _acpAdapterDeps.createClient injection).
 *
 * Architectural split (post-issue-939 refactor):
 * - **Adapter** is a transport primitive: when the watchdog invokes its cancel
 *   hook, the adapter returns `CompleteResult { cancelled: true }` with no
 *   `adapterFailure`. It does NOT name a policy outcome.
 * - **Wiring layer** (SessionManager / AgentManager) maps `cancelled: true` to
 *   the `fail-stale` AdapterFailure. End-to-end fail-stale assertions live in
 *   the SessionManager test suite.
 *
 * These tests therefore verify the adapter's transport contract:
 * AC9:  Hanging prompt → adapter returns cancelled:true before wall-clock timeout
 * AC10: Periodic agent_thought_chunk events → watchdog does NOT cancel
 * AC11: Periodic usage_update events → watchdog does NOT cancel
 * AC7:  Idle-watchdog cancellation is distinguishable from wall-clock timeout
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import {
  _acpAdapterDeps,
  AcpAgentAdapter,
  type AcpClient,
  type AcpClientOptions,
  type AcpSession,
  type AcpSessionResponse,
} from "@/agents";
import { type AgentStreamEvent, AgentStreamEventBus, attachAgentIdleWatchdog } from "@/runtime";

// setTimeout is permitted here for controlled test delays (not Bun.sleep — see testing-rules.md)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeWatchdogConfig(
  idleTimeoutMs: number,
  activityKinds: ("message_update" | "thinking_update" | "usage_update" | "tool_call_update")[] = [
    "message_update",
    "thinking_update",
    "usage_update",
    "tool_call_update",
  ],
  toolCallOnlyIdleTimeoutMs = idleTimeoutMs * 2,
) {
  return makeNaxConfig({
    agent: {
      idleWatchdog: {
        enabled: true,
        mode: "cancel",
        idleTimeoutSeconds: idleTimeoutMs / 1000,
        toolCallOnlyIdleTimeoutSeconds: toolCallOnlyIdleTimeoutMs / 1000,
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
    resolvedPermissions: { mode: "approve-reads" as const },
    modelDef: { provider: "anthropic" as const, model: "claude-haiku-4-5" as const },
    workdir: "/tmp/test",
    timeoutMs,
    storyId: "us-test",
    // Wiring-layer responsibility: populate the watchdog registry from the
    // adapter's onActiveCall callback. The adapter has no knowledge of the
    // registry — it just hands out (callId, cancel) pairs as calls start.
    onActiveCall: (callId: string, cancel: () => Promise<void>) => {
      registry.set(callId, cancel);
    },
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
 * Adapter calls `opts.onActiveCall(callId, cancelFn)` — the test plumbing
 * registers `cancelFn` in the watchdog registry. When the watchdog times out,
 * it invokes `registry.get(callId)()` which resolves session.prompt() with
 * `stopReason: "error"` and `cancelled: true`. The adapter forwards
 * `cancelled` on its CompleteResult; the wiring layer (not exercised here)
 * is responsible for mapping that to fail-stale.
 */
function makeHangingMockClient(opts: AcpClientOptions | undefined): AcpClient {
  const callId = `hang-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let resolve: ((r: AcpSessionResponse) => void) | null = null;

  const session: AcpSession = {
    async prompt(): Promise<AcpSessionResponse> {
      // Watchdog cancel resolves prompt() with the typed cancelReason so the
      // adapter can classify the failure as fail-stale.
      opts?.onActiveCall?.(callId, async () => {
        resolve?.({
          messages: [{ role: "assistant", content: "" }],
          stopReason: "error",
          cancelled: true,
        });
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
      resolve?.({
        messages: [{ role: "assistant", content: "" }],
        stopReason: "error",
        cancelled: true,
      });
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
  activityKind: "agent.message_update" | "agent.thinking_update" | "agent.usage_update" | "agent.tool_call_update",
  intervalMs: number,
  durationMs: number,
): AcpClient {
  const callId = `active-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const session: AcpSession = {
    async prompt(): Promise<AcpSessionResponse> {
      opts?.onActiveCall?.(callId, async () => {
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
        } else if (activityKind === "agent.tool_call_update") {
          opts?.onStreamActivity?.({ ...activityBase, kind: activityKind, toolName: "bash" });
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

  // AC9: Hanging prompt with no stream activity → adapter surfaces cancelled:true
  // (not a fail-stale AdapterFailure — that classification lives in the wiring layer).
  test("hanging prompt with no stream activity surfaces cancelled:true before wall-clock timeout", async () => {
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

      // Transport contract: external cancel surfaces as `cancelled: true` with
      // no policy-named adapterFailure. The wiring layer maps cancelled → fail-stale.
      expect(result.cancelled).toBe(true);
      expect(result.adapterFailure).toBeUndefined();
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

  test("prompt emitting only periodic tool_call_update events is NOT cancelled before the secondary cap", async () => {
    const IDLE_TIMEOUT_MS = 80;
    const TOOL_CALL_ONLY_TIMEOUT_MS = 220;
    const ACTIVITY_INTERVAL_MS = 30;
    const PROMPT_DURATION_MS = 170;

    const eventBus = new AgentStreamEventBus();
    const registry = new Map<string, () => Promise<void>>();
    const config = makeWatchdogConfig(
      IDLE_TIMEOUT_MS,
      ["message_update", "thinking_update", "usage_update", "tool_call_update"],
      TOOL_CALL_ONLY_TIMEOUT_MS,
    );
    const detach = attachAgentIdleWatchdog(eventBus, registry, config);

    _acpAdapterDeps.createClient = (_cmd, _cwd, _timeout, _onPid, _retries, _onExit, opts) =>
      makeActiveSessionMockClient(opts, "agent.tool_call_update", ACTIVITY_INTERVAL_MS, PROMPT_DURATION_MS);

    try {
      const adapter = new AcpAgentAdapter("claude");
      const result = await adapter.complete("test prompt", {
        ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus)),
      });

      expect(result.adapterFailure).toBeUndefined();
      expect(result.output).toBe("done");
    } finally {
      detach();
    }
  });

  // AC7: Idle watchdog cancellation is distinguishable from wall-clock timeout.
  // Idle timeout → CompleteResult { cancelled: true } (no adapterFailure).
  // Wall-clock timeout → throws CompleteError. The wiring layer (not exercised
  // here) maps cancelled:true → fail-stale; nothing maps wall-clock to fail-*.
  test("idle watchdog cancellation is distinguishable from wall-clock timeout", async () => {
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

      // Idle watchdog → structured cancelled signal (no adapterFailure here)
      expect(result.cancelled).toBe(true);
      expect(result.adapterFailure).toBeUndefined();
      // Output is empty on cancelled return — caller cannot mistake it for
      // a successful completion.
      expect(result.output).toBe("");
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
      expect(result.cancelled).toBe(true);
      // Must resolve well before the wall-clock timeout
      expect(elapsedMs).toBeLessThan(WALL_CLOCK_TIMEOUT_MS / 2);
    } finally {
      detach();
    }
  });
});
