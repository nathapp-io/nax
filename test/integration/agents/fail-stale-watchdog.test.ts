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
 *
 * Time model: every timer — watchdog tick, grace period, mock-client activity
 * loop, and the `setTimeout` the adapter itself arms — runs on a shared
 * virtual clock (`makeFakeClock`). Tests step time with `clock.advance(ms)`
 * instead of `await sleep(ms)`, so a 250ms prompt costs the test ~1ms of
 * wall-clock. The watchdog's `_idleWatchdogDeps.{setTimeout,clearTimeout,now}`
 * seam and the existing harness drive this; the mock client below takes the
 * same clock so its activity loop and timestamps stay consistent with the
 * watchdog's "time since last activity" check.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFakeClock, makeNaxConfig } from "@test/helpers";
import {
  _acpAdapterDeps,
  AcpAgentAdapter,
  type AcpClient,
  type AcpClientOptions,
  type AcpSession,
  type AcpSessionResponse,
} from "@/agents";
import { _idleWatchdogDeps, type AgentStreamEvent, AgentStreamEventBus, attachAgentIdleWatchdog } from "@/runtime";

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
    resolvedPermissions: { mode: "approve-reads" as const, bashApproval: "raw" as const },
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
 *
 * `clock` is the same FakeClock the watchdog runs on. The prompt just parks
 * the resolver; the watchdog's tick (driven by `clock.advance`) decides when
 * the test resolves.
 */
function makeHangingMockClient(opts: AcpClientOptions | undefined, clock: ReturnType<typeof makeFakeClock>): AcpClient {
  const callId = `hang-${Math.random().toString(36).slice(2)}`;
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
        timestamp: clock.now(),
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
 * After `durationMs` (virtual time) the prompt resolves with end_turn.
 *
 * `clock.advance(intervalMs)` is used in place of `await sleep(intervalMs)`:
 * advancing the fake clock by the activity interval also fires any watchdog
 * ticks that fall in that window, so the watchdog sees the activity at the
 * correct virtual timestamp and decides not to cancel.
 */
function makeActiveSessionMockClient(
  opts: AcpClientOptions | undefined,
  activityKind: "agent.message_update" | "agent.thinking_update" | "agent.usage_update" | "agent.tool_call_update",
  intervalMs: number,
  durationMs: number,
  clock: ReturnType<typeof makeFakeClock>,
): AcpClient {
  const callId = `active-${Math.random().toString(36).slice(2)}`;

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
        timestamp: clock.now(),
      });

      const start = clock.now();
      while (clock.now() - start < durationMs) {
        // Advance fires any watchdog tick in the same window, then we emit the
        // activity on the post-advance clock so the watchdog sees the reset.
        await clock.advance(intervalMs);
        const activityBase = { ...BASE_STREAM_EVENT, callId, timestamp: clock.now() };
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
        timestamp: clock.now(),
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
  let origResolveRateCard: typeof _acpAdapterDeps.resolveRateCard;
  let origSetTimeout: typeof _idleWatchdogDeps.setTimeout;
  let origClearTimeout: typeof _idleWatchdogDeps.clearTimeout;
  let origNow: typeof _idleWatchdogDeps.now;
  let clock: ReturnType<typeof makeFakeClock>;

  beforeEach(() => {
    origCreateClient = _acpAdapterDeps.createClient;
    origResolveRateCard = _acpAdapterDeps.resolveRateCard;
    origSetTimeout = _idleWatchdogDeps.setTimeout;
    origClearTimeout = _idleWatchdogDeps.clearTimeout;
    origNow = _idleWatchdogDeps.now;
    clock = makeFakeClock();
    _idleWatchdogDeps.setTimeout = clock.setTimeout as typeof _idleWatchdogDeps.setTimeout;
    _idleWatchdogDeps.clearTimeout = clock.clearTimeout as typeof _idleWatchdogDeps.clearTimeout;
    _idleWatchdogDeps.now = clock.now;
    // resolveRateCard does real I/O (catalog lookup) on first call, which blocks
    // the call_started event from reaching the watchdog in wall-clock time.
    // The hanging-prompt tests below rely on `clock.advance` to fire the
    // watchdog tick, so this needs to settle instantly on a microtask.
    _acpAdapterDeps.resolveRateCard = (() => {
      const fallback = {
        rates: { inputPer1M: 1, outputPer1M: 2 },
        source: "catalog-rates" as const,
      };
      return Promise.resolve(fallback);
    }) as typeof _acpAdapterDeps.resolveRateCard;
  });

  afterEach(() => {
    _acpAdapterDeps.createClient = origCreateClient;
    _acpAdapterDeps.resolveRateCard = origResolveRateCard;
    _idleWatchdogDeps.setTimeout = origSetTimeout;
    _idleWatchdogDeps.clearTimeout = origClearTimeout;
    _idleWatchdogDeps.now = origNow;
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
      makeHangingMockClient(opts, clock);

    // adapter.complete() awaits resolveRateCard() before invoking session.prompt(),
    // so the call_started event (which arms the watchdog tick) only fires after
    // a microtask. First advance drains microtasks so prompt() runs and the tick
    // timer is armed; the second advance fires the tick at the idle threshold.
    const completePromise = new AcpAgentAdapter("claude").complete("test prompt", {
      ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus), WALL_CLOCK_TIMEOUT_MS),
    });

    await clock.advance(0);
    await clock.advance(IDLE_TIMEOUT_MS * 2);

    const result = await completePromise;

    try {
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
      makeActiveSessionMockClient(opts, "agent.thinking_update", ACTIVITY_INTERVAL_MS, PROMPT_DURATION_MS, clock);

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
      makeActiveSessionMockClient(opts, "agent.usage_update", ACTIVITY_INTERVAL_MS, PROMPT_DURATION_MS, clock);

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
      makeActiveSessionMockClient(opts, "agent.tool_call_update", ACTIVITY_INTERVAL_MS, PROMPT_DURATION_MS, clock);

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
      makeHangingMockClient(opts, clock);

    const completePromise = new AcpAgentAdapter("claude").complete("test prompt", {
      ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus), 5000),
    });

    await clock.advance(0);
    await clock.advance(IDLE_TIMEOUT_MS * 2);
    const result = await completePromise;

    try {
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
      makeHangingMockClient(opts, clock);

    const startMs = clock.now();
    const completePromise = new AcpAgentAdapter("claude").complete("test prompt", {
      ...makeCompleteOptions(registry, eventBus.emitAgentStream.bind(eventBus), WALL_CLOCK_TIMEOUT_MS),
    });

    // Drain microtasks so session.prompt() runs (and arms the watchdog tick),
    // then drive past the idle threshold. The relative ordering (idle < wall)
    // is what the assertion actually checks — both are virtual here, the test
    // just requires the watchdog cancels before the adapter's internal deadline.
    await clock.advance(0);
    await clock.advance(SHORT_IDLE_TIMEOUT_MS * 2);

    const result = await completePromise;
    const elapsedVirtualMs = clock.now() - startMs;

    try {
      // Idle watchdog must have fired — not the wall-clock timeout
      expect(result.cancelled).toBe(true);
      // The watchdog's cancel must resolve before the wall-clock budget is
      // consumed — expressed in virtual ms since both timers are virtual.
      expect(elapsedVirtualMs).toBeLessThan(WALL_CLOCK_TIMEOUT_MS / 2);
    } finally {
      detach();
    }
  });
});
