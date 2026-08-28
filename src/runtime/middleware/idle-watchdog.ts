import type { NaxConfig, PipelineStage } from "@/config";
import { getSafeLogger } from "@/logger";
import type { AgentStreamEvent, IAgentStreamEventBus } from "@/runtime";

export interface WatchdogState {
  readonly callId: string;
  readonly agentName: string;
  readonly sessionName: string;
  readonly storyId?: string;
  readonly stage?: PipelineStage;
  readonly pid?: number;
  startedAt: number;
  lastActivityAt: number;
  lastNonToolCallActivityAt: number;
  messageUpdates: number;
  thinkingUpdates: number;
  usageUpdates: number;
  toolCallUpdates: number;
}

type IdleTimeoutReason = "idle_timeout_exceeded" | "tool_call_only_idle_timeout_exceeded";

/**
 * Injectable clock — the tick timer, the grace timer, and every elapsed-time
 * comparison read through this.
 *
 * The watchdog is defined entirely in terms of "has enough time passed", so
 * testing it against the real clock means sleeping through each threshold and
 * asserting on a margin. That is slow and it is what made this suite flaky
 * twice before (#1002, #1008). Injecting the clock lets tests step time
 * exactly, so the assertions become deterministic instead of probabilistic.
 *
 * @internal
 */
export const _idleWatchdogDeps = {
  setTimeout: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as (fn: () => void, ms: number) => unknown,
  clearTimeout: ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>)) as (id: unknown) => void,
  now: (): number => Date.now(),
};

interface WatchdogStateInternal extends WatchdogState {
  cancelAttempts: number;
  graceTimer?: unknown;
  inGracePeriod: boolean;
  warnedForCurrentIdlePeriod: boolean;
  graceReason?: IdleTimeoutReason;
}

// setTimeout is permitted here for the recurring tick and grace period cancellation via clearTimeout
function scheduleTickIfNeeded(tickRef: { handle: unknown }, tick: () => void, intervalMs: number): void {
  if (tickRef.handle !== null) return;
  tickRef.handle = _idleWatchdogDeps.setTimeout(tick, intervalMs);
}

function handleObserveTimeout(
  state: WatchdogStateInternal,
  reason: IdleTimeoutReason,
  idleDurationMs: number,
  nonToolCallIdleMs: number,
): void {
  if (state.warnedForCurrentIdlePeriod) return;
  state.warnedForCurrentIdlePeriod = true;
  getSafeLogger()?.warn(
    "idle-watchdog",
    reason === "tool_call_only_idle_timeout_exceeded"
      ? "Tool-call-only idle timeout exceeded"
      : "Idle timeout exceeded",
    {
      storyId: state.storyId,
      key: reason,
      callId: state.callId,
      mode: "observe",
      idleDurationMs,
      nonToolCallIdleMs,
      toolCallUpdates: state.toolCallUpdates,
    },
  );
}

async function handleCancelTimeout(
  state: WatchdogStateInternal,
  reason: IdleTimeoutReason,
  controllerRegistry: Map<string, () => Promise<void>>,
  maxRetryAttempts: number,
  activeStates: Map<string, WatchdogStateInternal>,
): Promise<void> {
  if (state.cancelAttempts >= maxRetryAttempts) {
    getSafeLogger()?.error("idle-watchdog", "Max retry attempts exceeded", {
      storyId: state.storyId,
      key: "max_retry_attempts_exceeded",
      callId: state.callId,
      cancelAttempts: state.cancelAttempts,
    });
    activeStates.delete(state.callId);
    return;
  }
  state.cancelAttempts++;
  // Reset synchronously to prevent double-trigger in next tick
  state.lastActivityAt = _idleWatchdogDeps.now();
  getSafeLogger()?.warn(
    "idle-watchdog",
    reason === "tool_call_only_idle_timeout_exceeded" ? "Canceling tool-call-only idle call" : "Canceling idle call",
    {
      storyId: state.storyId,
      key: reason,
      callId: state.callId,
      mode: "cancel",
      action: "cancel",
      toolCallUpdates: state.toolCallUpdates,
    },
  );
  const cancel = controllerRegistry.get(state.callId);
  if (cancel) await cancel().catch(() => {});
}

function handleWarnThenCancelTimeout(
  state: WatchdogStateInternal,
  reason: IdleTimeoutReason,
  controllerRegistry: Map<string, () => Promise<void>>,
  maxRetryAttempts: number,
  idleTimeoutMs: number,
  toolCallOnlyTimeoutMs: number,
  graceMs: number,
  activeStates: Map<string, WatchdogStateInternal>,
): void {
  if (state.cancelAttempts >= maxRetryAttempts) {
    getSafeLogger()?.error("idle-watchdog", "Max retry attempts exceeded", {
      storyId: state.storyId,
      key: "max_retry_attempts_exceeded",
      callId: state.callId,
      cancelAttempts: state.cancelAttempts,
    });
    activeStates.delete(state.callId);
    return;
  }
  getSafeLogger()?.warn(
    "idle-watchdog",
    reason === "tool_call_only_idle_timeout_exceeded"
      ? "Tool-call-only idle timeout exceeded, entering grace period"
      : "Idle timeout exceeded, entering grace period",
    {
      storyId: state.storyId,
      key: reason,
      callId: state.callId,
      mode: "warn-then-cancel",
      gracePeriodMs: graceMs,
      toolCallUpdates: state.toolCallUpdates,
    },
  );
  state.inGracePeriod = true;
  state.graceReason = reason;
  // setTimeout permitted here for grace period cancellation via clearTimeout
  // The timer slot expects `void`; an async callback there would make a
  // rejection unobservable. Wrap so the promise is explicitly discarded.
  state.graceTimer = _idleWatchdogDeps.setTimeout(() => {
    void (async () => {
      if (!activeStates.has(state.callId)) return;
      state.inGracePeriod = false;
      state.graceTimer = undefined;
      state.graceReason = undefined;
      const currentReason = getTimeoutReason(state, _idleWatchdogDeps.now(), idleTimeoutMs, toolCallOnlyTimeoutMs);
      if (currentReason !== reason) return;
      state.cancelAttempts++;
      state.lastActivityAt = _idleWatchdogDeps.now();
      const cancel = controllerRegistry.get(state.callId);
      if (cancel) await cancel().catch(() => {});
    })();
  }, graceMs);
}

function clearGrace(state: WatchdogStateInternal): void {
  if (state.inGracePeriod && state.graceTimer !== undefined) {
    _idleWatchdogDeps.clearTimeout(state.graceTimer);
    state.graceTimer = undefined;
    state.inGracePeriod = false;
    state.graceReason = undefined;
  }
}

function resetActivity(state: WatchdogStateInternal, newTimestamp: number, options: { clearGrace: boolean }): void {
  state.lastActivityAt = newTimestamp;
  state.warnedForCurrentIdlePeriod = false;
  if (options.clearGrace) clearGrace(state);
}

function getTimeoutReason(
  state: WatchdogStateInternal,
  now: number,
  idleTimeoutMs: number,
  toolCallOnlyTimeoutMs: number,
): IdleTimeoutReason | undefined {
  if (now - state.lastActivityAt >= idleTimeoutMs) return "idle_timeout_exceeded";
  if (toolCallOnlyTimeoutMs > idleTimeoutMs && now - state.lastNonToolCallActivityAt >= toolCallOnlyTimeoutMs) {
    return "tool_call_only_idle_timeout_exceeded";
  }
  return undefined;
}

export function attachAgentIdleWatchdog(
  agentStreamEvents: IAgentStreamEventBus,
  controllerRegistry: Map<string, () => Promise<void>>,
  config: NaxConfig,
): () => void {
  const watchdogConfig = config.agent?.idleWatchdog;
  if (!watchdogConfig?.enabled || watchdogConfig.mode === "off" || watchdogConfig.mode === undefined) {
    return agentStreamEvents.onAgentStream(() => {});
  }

  const mode = watchdogConfig.mode;
  const idleTimeoutMs = (watchdogConfig.idleTimeoutSeconds ?? 30) * 1000;
  const toolCallOnlyTimeoutMs = (watchdogConfig.toolCallOnlyIdleTimeoutSeconds ?? 0) * 1000;
  const graceMs = (watchdogConfig.cancelGraceSeconds ?? 5) * 1000;
  const maxRetryAttempts = watchdogConfig.maxRetryAttempts ?? 3;
  const activityKinds = new Set<string>(
    watchdogConfig.activityKinds ?? ["message_update", "thinking_update", "usage_update", "tool_call_update"],
  );
  // Poll at 1/4 of the idle timeout so detection latency is at most idleTimeout * 5/4
  // rather than up to 2× idleTimeout when the tick interval equals idleTimeoutMs.
  const tickIntervalMs = Math.max(1, Math.ceil(idleTimeoutMs / 4));

  const activeStates = new Map<string, WatchdogStateInternal>();
  const tickRef: { handle: ReturnType<typeof setTimeout> | null } = { handle: null };

  function tick(): void {
    tickRef.handle = null;
    const now = _idleWatchdogDeps.now();
    for (const [, state] of activeStates) {
      if (state.inGracePeriod) continue;
      const idleDurationMs = now - state.lastActivityAt;
      const nonToolCallIdleMs = now - state.lastNonToolCallActivityAt;
      const reason = getTimeoutReason(state, now, idleTimeoutMs, toolCallOnlyTimeoutMs);
      if (!reason) continue;
      if (mode === "observe") handleObserveTimeout(state, reason, idleDurationMs, nonToolCallIdleMs);
      else if (mode === "cancel") {
        void handleCancelTimeout(state, reason, controllerRegistry, maxRetryAttempts, activeStates);
      } else if (mode === "warn-then-cancel") {
        handleWarnThenCancelTimeout(
          state,
          reason,
          controllerRegistry,
          maxRetryAttempts,
          idleTimeoutMs,
          toolCallOnlyTimeoutMs,
          graceMs,
          activeStates,
        );
      }
    }
    if (activeStates.size > 0) scheduleTickIfNeeded(tickRef, tick, tickIntervalMs);
  }

  const unsubscribe = agentStreamEvents.onAgentStream((event: AgentStreamEvent) => {
    switch (event.kind) {
      case "agent.call_started": {
        const now = _idleWatchdogDeps.now();
        activeStates.set(event.callId, {
          callId: event.callId,
          agentName: event.agentName,
          sessionName: event.sessionName,
          storyId: event.storyId,
          stage: event.stage,
          pid: event.pid,
          startedAt: now,
          lastActivityAt: now,
          lastNonToolCallActivityAt: now,
          messageUpdates: 0,
          thinkingUpdates: 0,
          usageUpdates: 0,
          toolCallUpdates: 0,
          cancelAttempts: 0,
          inGracePeriod: false,
          warnedForCurrentIdlePeriod: false,
        });
        getSafeLogger()?.debug("idle-watchdog", "Watchdog tracking call", {
          storyId: event.storyId,
          callId: event.callId,
          mode,
          idleTimeoutMs,
          toolCallOnlyTimeoutMs,
        });
        scheduleTickIfNeeded(tickRef, tick, tickIntervalMs);
        break;
      }
      case "agent.message_update": {
        const state = activeStates.get(event.callId);
        if (state && activityKinds.has("message_update")) {
          state.messageUpdates++;
          state.lastNonToolCallActivityAt = event.timestamp;
          resetActivity(state, event.timestamp, { clearGrace: true });
        }
        break;
      }
      case "agent.thinking_update": {
        const state = activeStates.get(event.callId);
        if (state && activityKinds.has("thinking_update")) {
          state.thinkingUpdates++;
          state.lastNonToolCallActivityAt = event.timestamp;
          resetActivity(state, event.timestamp, { clearGrace: true });
        }
        break;
      }
      case "agent.usage_update": {
        const state = activeStates.get(event.callId);
        if (state && activityKinds.has("usage_update")) {
          state.usageUpdates++;
          state.lastNonToolCallActivityAt = event.timestamp;
          resetActivity(state, event.timestamp, { clearGrace: true });
        }
        break;
      }
      case "agent.tool_call_update": {
        const state = activeStates.get(event.callId);
        if (state && activityKinds.has("tool_call_update")) {
          state.toolCallUpdates++;
          resetActivity(state, event.timestamp, {
            clearGrace: state.graceReason === "idle_timeout_exceeded",
          });
        }
        break;
      }
      case "agent.process_update":
        // Do NOT reset lastActivityAt for process_update (AC4)
        break;
      case "agent.call_ended": {
        const state = activeStates.get(event.callId);
        if (state) {
          if (state.graceTimer !== undefined) _idleWatchdogDeps.clearTimeout(state.graceTimer);
          activeStates.delete(event.callId);
        }
        if (activeStates.size === 0 && tickRef.handle !== null) {
          _idleWatchdogDeps.clearTimeout(tickRef.handle);
          tickRef.handle = null;
        }
        break;
      }
    }
  });

  return () => {
    unsubscribe();
    for (const state of activeStates.values()) {
      if (state.graceTimer !== undefined) _idleWatchdogDeps.clearTimeout(state.graceTimer);
    }
    activeStates.clear();
    if (tickRef.handle !== null) {
      _idleWatchdogDeps.clearTimeout(tickRef.handle);
      tickRef.handle = null;
    }
  };
}
